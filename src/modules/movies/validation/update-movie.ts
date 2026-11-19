import { z } from "zod";
import { MOVIE_STATUSES } from "../../../models/movies.ts";

export const updateMovieBodySchema = z
  .object({
    // Same enum as the DB CHECK movies_status_valid: an unknown status is a 400 here,
    // not a constraint violation (500) in PostgreSQL.
    status: z.enum(MOVIE_STATUSES),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateMovieBody = z.infer<typeof updateMovieBodySchema>;
