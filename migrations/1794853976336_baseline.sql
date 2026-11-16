-- Up Migration

-- Baseline: reproduces the local DB schema as of 2026-11-16 (from `\d`, PostgreSQL 18),
-- including its weak spots (nullable status/version). Tightening goes into later migrations.
-- Existing DB that already has these tables: do NOT run; mark applied once with
--   npm run migrate:up -- --fake
-- Requires PostgreSQL 13+ (built-in gen_random_uuid()).

CREATE TABLE movies (
  id               uuid                     NOT NULL DEFAULT gen_random_uuid(),
  title            character varying(200)   NOT NULL,
  description      text,
  release_year     smallint                 NOT NULL,
  duration_minutes smallint                 NOT NULL,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  status           character varying(50)    DEFAULT NULL,
  version          integer,
  CONSTRAINT movies_pkey PRIMARY KEY (id),
  CONSTRAINT movies_duration_valid CHECK (duration_minutes >= 1 AND duration_minutes <= 1000),
  CONSTRAINT movies_release_year_valid CHECK (release_year >= 1888 AND release_year <= 2100),
  CONSTRAINT movies_title_not_empty CHECK (length(TRIM(BOTH FROM title)) > 0)
);

CREATE INDEX movies_created_at_id_idx ON movies (created_at DESC, id DESC);

CREATE TABLE cache_invalidation_outbox (
  id               bigint                   GENERATED ALWAYS AS IDENTITY,
  aggregate_type   text                     NOT NULL,
  aggregate_id     text                     NOT NULL,
  event_type       text                     NOT NULL,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  available_at     timestamp with time zone NOT NULL DEFAULT now(),
  attempts         integer                  NOT NULL DEFAULT 0,
  locked_by        text,
  locked_until     timestamp with time zone,
  processed_at     timestamp with time zone,
  dead_lettered_at timestamp with time zone,
  last_error       text,
  CONSTRAINT cache_invalidation_outbox_pkey PRIMARY KEY (id)
);

-- Partial index: only pending rows, stays small as processed rows accumulate.
CREATE INDEX cache_invalidation_outbox_pending_idx
  ON cache_invalidation_outbox (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- Down Migration

-- DESTRUCTIVE: drops both tables and all data. Fresh/disposable DB only.
DROP TABLE cache_invalidation_outbox;
DROP TABLE movies;
