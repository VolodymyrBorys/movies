import { Router, type Request, type Response } from "express";
import { REDIS } from "../infrastructure/redis.ts";
import { MOVIES } from "../models/movies.ts";
import { PG } from "../infrastructure/postgres.ts";
import { asyncHandler } from "../utils/errors.ts";
import { validate } from "../utils/validate-query.ts";
import { getMoviesQuerySchema } from "../modules/movies/validation/get-movies.ts";
import { getMovies, updateMovie } from "../modules/movies/movies.controller.ts";
import {
  updateMovieBodySchema,
  updateMovieParamsSchema,
} from "../modules/movies/validation/update-movie.ts";

export const router = Router();

router.get(
  "/movies",
  validate("params", getMoviesQuerySchema),
  asyncHandler(getMovies),
);

router.patch(
  "/movies/:id",
  validate("params", updateMovieParamsSchema),
  validate("body", updateMovieBodySchema),
  asyncHandler(updateMovie),
);
