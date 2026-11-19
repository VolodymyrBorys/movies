import { z } from "zod";

// Shared by GET/PATCH/DELETE /movies/:id. movies.id is uuid (DB schema is the source of truth).
export const movieIdParamsSchema = z.object({
  id: z.uuid("Invalid movie id"),
});

export type MovieIdParams = z.infer<typeof movieIdParamsSchema>;
