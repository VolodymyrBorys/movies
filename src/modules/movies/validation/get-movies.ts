import { z } from "zod";

export const getMoviesQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, "limit must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .transform((value) => value ?? 20),

  // Opaque keyset cursor; its content is decoded and validated in the service.
  cursor: z.string().min(1).max(128).optional(),

  sort: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type GetMoviesQuery = z.infer<typeof getMoviesQuerySchema>;
