import { Request, Response, NextFunction } from "express";
import { ApiError, isApiError } from "./errors";

export function ok(res: Response, data: unknown, meta?: Record<string, unknown>) {
  return res.json(meta ? { data, meta } : { data });
}

export function created(res: Response, data: unknown, meta?: Record<string, unknown>) {
  return res.status(201).json(meta ? { data, meta } : { data });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (isApiError(error)) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    });
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[500]", message, error instanceof Error ? error.stack : error);
  return res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message,
      details: {},
    },
  });
}
