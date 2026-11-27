import { Router } from "express";
import { getReviewJob } from "../modules/reviews/review-jobs.controller.ts";
import { reviewJobIdParamsSchema } from "../modules/reviews/validation/review-job-id-params.ts";
import { asyncHandler } from "../utils/errors.ts";
import { validate } from "../utils/validate-query.ts";

// The job is created by POST /v1/movies/:id/review (routes/movies.ts).
export const router = Router();

router.get(
  "/review-jobs/:id",
  validate("params", reviewJobIdParamsSchema),
  asyncHandler(getReviewJob),
);
