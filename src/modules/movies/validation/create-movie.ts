import { z } from "zod";

// Mirrors the DB constraints on `movies` (baseline migration), so invalid input is a 400
// here instead of a CHECK violation (500) in PostgreSQL.
export const createMovieBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional(),
    releaseYear: z.number().int().min(1888).max(2100),
    durationMinutes: z.number().int().min(1).max(1000),
    status: z.enum(["draft", "published", "archived"]).default("draft"),
  })
  // Rejects client-supplied id/version/created_at instead of silently ignoring them.
  .strict();

export type CreateMovieBody = z.infer<typeof createMovieBodySchema>;
