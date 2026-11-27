import { z } from "zod";

export const reviewJobIdParamsSchema = z.object({
  id: z.uuid("Invalid review job id"),
});

export type ReviewJobIdParams = z.infer<typeof reviewJobIdParamsSchema>;
