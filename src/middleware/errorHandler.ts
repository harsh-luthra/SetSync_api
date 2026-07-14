import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppwriteException } from 'node-appwrite';
import { logger } from '../config/logger';

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Wraps async route handlers so rejections reach the error handler (Express 4). */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(422).json({
      message: 'Validation failed',
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ message: err.message, details: err.details });
    return;
  }

  if (err instanceof AppwriteException) {
    const status = err.code === 404 ? 404 : err.code === 409 ? 409 : 502;
    logger.error({ err, path: req.path }, 'Appwrite error');
    res.status(status).json({ message: status === 502 ? 'Upstream storage error' : err.message });
    return;
  }

  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error' });
}
