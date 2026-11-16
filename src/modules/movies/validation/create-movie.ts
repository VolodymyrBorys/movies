import z from "zod";

export const createMovieSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  releaseYear: z.number().int().min(1888).max(2100),
});
