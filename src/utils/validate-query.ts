import type { RequestHandler } from "express";
import type { ZodType } from "zod";

type RequestPart = "body" | "params";

export function validate(part: RequestPart, schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const input: unknown = part === "body" ? req.body : req.params;

    const result = schema.safeParse(input);

    if (!result.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid request ${part}`,
          details: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }

    if (part === "body") {
      res.locals.validatedBody = result.data;
    } else {
      res.locals.validatedParams = result.data;
    }

    next();
  };
}
