import type { Request, Response } from "express";
import type { GetMoviesQuery } from "./validation/get-movies.ts";
import type { CreateMovieBody } from "./validation/create-movie.ts";
import { MovieService } from "./movies.service.ts";
import type { UpdateMovieBody } from "./validation/update-movie.ts";
import type { MovieIdParams } from "./validation/movie-id-params.ts";

const moviesService = new MovieService();

export const getMovies = async (_req: Request, res: Response) => {
  const query = res.locals.validatedQuery as GetMoviesQuery;
  const movies = await moviesService.getMovies(query);
  res.status(200).json(movies);
};

export const createMovie = async (_req: Request, res: Response) => {
  const body = res.locals.validatedBody as CreateMovieBody;

  const movie = await moviesService.createMovie(body);

  res.location(`/v1/movies/${movie.id}`).status(201).json({ data: movie });
};

export const getMovieById = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;

  const movie = await moviesService.getMovieById(id);

  if (!movie) {
    res.status(404).json({
      error: {
        code: "MOVIE_NOT_FOUND",
        message: "Movie not found",
      },
    });
    return;
  }

  res.status(200).json({ data: movie });
};

export const updateMovie = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;
  const body = res.locals.validatedBody as UpdateMovieBody;

  const movie = await moviesService.updateMovie(id, body);

  if (!movie) {
    res.status(404).json({
      error: {
        code: "MOVIE_NOT_FOUND",
        message: "Movie not found",
      },
    });
    return;
  }

  res.status(200).json({ data: movie });
};

export const deleteMovie = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;

  const isDeleted = await moviesService.deleteMovie(id);

  if (!isDeleted) {
    res.status(404).json({
      error: {
        code: "MOVIE_NOT_FOUND",
        message: "Movie not found",
      },
    });
    return;
  }

  res.status(204).end();
};
