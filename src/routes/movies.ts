import { Router, type Request, type Response } from "express";
import { REDIS } from "../infrastructure/redis.ts";
import { MOVIES } from "../models/movies.ts";
import { PG } from "../infrastructure/postgres.ts";
import { asyncHandler } from "../utils/errors.ts";
import { validate } from "../utils/validate-query.ts";
import { getMoviesQuerySchema } from "../modules/movies/validation/get-movies.ts";
import {
  createMovie,
  deleteMovie,
  getMovieById,
  getMovies,
  updateMovie,
} from "../modules/movies/movies.controller.ts";
import { reviewMovie } from "../modules/movies/movie-review.controller.ts";
import { createMovieBodySchema } from "../modules/movies/validation/create-movie.ts";
import { movieIdParamsSchema } from "../modules/movies/validation/movie-id-params.ts";
import { updateMovieBodySchema } from "../modules/movies/validation/update-movie.ts";

export const router = Router();

router.get(
  "/movies",
  validate("query", getMoviesQuerySchema),
  asyncHandler(getMovies),
);

router.post(
  "/movies",
  validate("body", createMovieBodySchema),
  asyncHandler(createMovie),
);

router.get(
  "/movies/:id",
  validate("params", movieIdParamsSchema),
  asyncHandler(getMovieById),
);

router.patch(
  "/movies/:id",
  validate("params", movieIdParamsSchema),
  validate("body", updateMovieBodySchema),
  asyncHandler(updateMovie),
);

router.delete(
  "/movies/:id",
  validate("params", movieIdParamsSchema),
  asyncHandler(deleteMovie),
);

router.post(
  "/movies/:id/review",
  validate("params", movieIdParamsSchema),
  asyncHandler(reviewMovie),
);
