import type { Request, Response } from "express";
import type { GetMoviesQuery } from "./validation/get-movies.ts";
import type { CreateMovieBody } from "./validation/create-movie.ts";
import { MovieService } from "./movies.service.ts";
import type { UpdateMovieBody } from "./validation/update-movie.ts";
import type { MovieIdParams } from "./validation/movie-id-params.ts";
import { movieEtag, parseIfMatch } from "./etag.ts";

const moviesService = new MovieService();

export const getMovies = async (_req: Request, res: Response) => {
  const query = res.locals.validatedQuery as GetMoviesQuery;
  const movies = await moviesService.getMovies(query);
  res.status(200).json(movies);
};

export const createMovie = async (_req: Request, res: Response) => {
  const body = res.locals.validatedBody as CreateMovieBody;

  const movie = await moviesService.createMovie(body);

  res
    .location(`/v1/movies/${movie.id}`)
    .set("ETag", movieEtag(movie.version))
    .status(201)
    .json({ data: movie });
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

  // Express answers a matching If-None-Match with 304 (req.fresh) once ETag is set.
  res.set("ETag", movieEtag(movie.version)).status(200).json({ data: movie });
};

export const updateMovie = async (req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;
  const body = res.locals.validatedBody as UpdateMovieBody;
  // Throws InvalidIfMatchError (400) before any storage access.
  const ifMatch = parseIfMatch(req.get("if-match"));

  const result = await moviesService.updateMovie(id, body, ifMatch);

  switch (result.kind) {
    case "updated":
      res
        .set("ETag", movieEtag(result.movie.version))
        .status(200)
        .json({ data: result.movie });
      return;
    case "version_mismatch":
      res.status(412).json({
        error: {
          code: "PRECONDITION_FAILED",
          message: "Movie was modified; fetch it again and retry with the new ETag",
        },
      });
      return;
    case "not_found":
      // LAB: RFC 9110 evaluates If-Match on a missing resource as false (→ 412); 404 is
      // returned instead because it tells the client more. Document it in the API contract.
      res.status(404).json({
        error: {
          code: "MOVIE_NOT_FOUND",
          message: "Movie not found",
        },
      });
      return;
  }
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
