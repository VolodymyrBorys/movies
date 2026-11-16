import { z } from "zod";

export const getMoviesQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .transform((value) => value ?? 20),

  offset: z
    .string()
    .regex(/^\d+$/, "offset must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(0).max(1_000_000))
    .optional()
    .transform((value) => value ?? 0),

  sort: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type GetMoviesQuery = z.infer<typeof getMoviesQuerySchema>;
