-- Up Migration

-- P5.1: async movie review jobs + outbox for broker messages (relay in the worker, P5.3).
-- New tables only; the running app version doesn't touch them (deploy-compatible).
-- Locks: the FK takes SHARE ROW EXCLUSIVE on movies while CREATE TABLE runs — movie writes
-- wait briefly, no scan (the new table is empty). Runner sets lock_timeout = 5s.

CREATE TABLE review_jobs (
  id            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  movie_id      uuid                     NOT NULL,
  movie_version integer                  NOT NULL,
  status        text                     NOT NULL DEFAULT 'queued',
  attempts      integer                  NOT NULL DEFAULT 0,
  locked_by     text,
  locked_until  timestamp with time zone,
  review        text,
  model         text,
  last_error    text,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  started_at    timestamp with time zone,
  finished_at   timestamp with time zone,
  CONSTRAINT review_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT review_jobs_movie_fk FOREIGN KEY (movie_id)
    REFERENCES movies (id) ON DELETE CASCADE,
  CONSTRAINT review_jobs_status_valid
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  CONSTRAINT review_jobs_movie_version_positive CHECK (movie_version >= 1),
  CONSTRAINT review_jobs_attempts_non_negative CHECK (attempts >= 0),
  -- Lease is all-or-nothing and exists exactly while the job is running.
  CONSTRAINT review_jobs_lease_complete CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CONSTRAINT review_jobs_lease_iff_running CHECK ((status = 'running') = (locked_by IS NOT NULL)),
  -- Result is all-or-nothing and exists exactly for succeeded jobs.
  CONSTRAINT review_jobs_result_complete CHECK ((review IS NULL) = (model IS NULL)),
  CONSTRAINT review_jobs_result_iff_succeeded CHECK ((status = 'succeeded') = (review IS NOT NULL)),
  CONSTRAINT review_jobs_finished_iff_terminal
    CHECK ((status IN ('succeeded', 'failed', 'superseded')) = (finished_at IS NOT NULL))
);

-- At most one active or successful job per (movie, version). Concurrent POSTs dedupe via
--   INSERT ... ON CONFLICT (movie_id, movie_version)
--     WHERE status IN ('queued', 'running', 'succeeded') DO NOTHING
-- failed / superseded rows don't block a new job for the same version.
CREATE UNIQUE INDEX review_jobs_movie_version_active_uq
  ON review_jobs (movie_id, movie_version)
  WHERE status IN ('queued', 'running', 'succeeded');

-- FK support: DELETE FROM movies cascades by movie_id; without this index every movie delete
-- seq-scans review_jobs (the partial index above misses failed/superseded rows).
CREATE INDEX review_jobs_movie_id_idx ON review_jobs (movie_id);

CREATE TABLE message_outbox (
  id               bigint                   GENERATED ALWAYS AS IDENTITY,
  message_id       uuid                     NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type   text                     NOT NULL,
  aggregate_id     text                     NOT NULL,
  routing_key      text                     NOT NULL,
  payload          jsonb                    NOT NULL,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  available_at     timestamp with time zone NOT NULL DEFAULT now(),
  attempts         integer                  NOT NULL DEFAULT 0,
  locked_by        text,
  locked_until     timestamp with time zone,
  published_at     timestamp with time zone,
  dead_lettered_at timestamp with time zone,
  last_error       text,
  CONSTRAINT message_outbox_pkey PRIMARY KEY (id),
  -- Stable AMQP messageId: the same value on every republish (relay is at-least-once).
  CONSTRAINT message_outbox_message_id_key UNIQUE (message_id),
  CONSTRAINT message_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT message_outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT message_outbox_lease_complete CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
  CONSTRAINT message_outbox_single_outcome CHECK (published_at IS NULL OR dead_lettered_at IS NULL)
);

-- Pending rows only. The relay claims with ORDER BY available_at, id to match this index.
CREATE INDEX message_outbox_pending_idx
  ON message_outbox (available_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Down Migration

-- DESTRUCTIVE: drops all review jobs and unpublished messages. Disposable DB, or only after
-- the P5 code that writes these tables is reverted.
DROP TABLE message_outbox;
DROP TABLE review_jobs;
