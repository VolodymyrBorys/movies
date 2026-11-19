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
  getMovies,
  updateMovie,
} from "../modules/movies/movies.controller.ts";
import { createMovieBodySchema } from "../modules/movies/validation/create-movie.ts";
import {
  updateMovieBodySchema,
  updateMovieParamsSchema,
} from "../modules/movies/validation/update-movie.ts";

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

router.patch(
  "/movies/:id",
  validate("params", updateMovieParamsSchema),
  validate("body", updateMovieBodySchema),
  asyncHandler(updateMovie),
);

router.delete(
  "/movies/:id",
  validate("params", updateMovieParamsSchema),
  asyncHandler(deleteMovie),
);
