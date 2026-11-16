import type { Request, Response } from "express";
import type { GetMoviesQuery } from "./validation/get-movies.ts";
import { MovieService } from "./movies.service.ts";
import type {
  UpdateMovieBody,
  UpdateMovieParams,
} from "./validation/update-movie.ts";

const moviesService = new MovieService();

export const getMovies = async (_req: Request, res: Response) => {
  const query = res.locals.validatedQuery as GetMoviesQuery;
  const movies = await moviesService.getMovies(query);
  res.status(200).json(movies);
};

export const updateMovie = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as UpdateMovieParams;
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
  const { id } = res.locals.validatedParams as UpdateMovieParams;

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

  res.status(200).json({ msg: "movie is deleted" });
};
