import { z } from "zod";

export const updateMovieParamsSchema = z.object({
  // movies.id is uuid (DB schema is the source of truth).
  id: z.uuid("Invalid movie id"),
});

export const updateMovieBodySchema = z
  .object({
    status: z.string(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateMovieParams = z.infer<typeof updateMovieParamsSchema>;

export type UpdateMovieBody = z.infer<typeof updateMovieBodySchema>;
