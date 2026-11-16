import { z } from "zod";

export const updateMovieParamsSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/, "Invalid movie id"),
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
