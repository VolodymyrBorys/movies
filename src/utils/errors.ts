import type { ErrorRequestHandler } from "express";

import type { Request, Response, NextFunction, RequestHandler } from "express";

export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",
  CONFLICT: "CONFLICT",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  DEPENDENCY_TIMEOUT: "DEPENDENCY_TIMEOUT",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  OPERATION_TIMEOUT: "OPERATION_TIMEOUT",
  OPERATION_ABORTED: "OPERATION_ABORTED",
} as const;

export type AppErrorOptions = {
  code: string;
  statusCode: number;
  isOperational?: boolean;
  retryable?: boolean;
  expose?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly retryable: boolean;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });

    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.isOperational = options.isOperational ?? true;
    this.retryable = options.retryable ?? false;

    this.expose = options.expose ?? options.statusCode < 500;
  }
}

/* custom error */

export function badRequest(cause?: unknown): AppError {
  return new AppError("Invalid request", {
    code: "BAD_REQUEST",
    statusCode: 400,
    cause,
  });
}

export function notFound(message = "Resource not found"): AppError {
  return new AppError(message, {
    code: "RESOURCE_NOT_FOUND",
    statusCode: 404,
  });
}

export function conflict(): AppError {
  return new AppError("Resource conflict", {
    code: "RESOURCE_CONFLICT",
    statusCode: 409,
  });
}

export function internalError(cause?: unknown): AppError {
  return new AppError("Internal server error", {
    code: "INTERNAL_ERROR",
    statusCode: 500,
    cause,
    expose: false,
  });
}

/* error handler */

type BodyParserError = Error & {
  type?: string;
};

function isMalformedJson(error: unknown): error is BodyParserError {
  return (
    error instanceof SyntaxError &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  _next,
) => {
  if (res.headersSent) {
    req.log.error({ err: error }, "Error after response headers sent");
    return _next(error);
  }

  if (isMalformedJson(error)) {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON",
      },
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      req.log.error({ err: error, code: error.code }, error.message);
    } else {
      req.log.warn({ err: error, code: error.code }, error.message);
    }

    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : "Internal server error",
      },
    });
    return;
  }

  req.log.error({ err: error }, "Unhandled application error");

  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
};
