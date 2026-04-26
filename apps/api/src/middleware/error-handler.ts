import type { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode, httpStatusFor, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next is required to be 4-arg for express to recognize this as an error handler
  _next: NextFunction,
): void {
  const correlationId = req.correlationId;
  const appErr = isAppError(err)
    ? err
    : AppError.from(err, ErrorCode.INTERNAL_ERROR);

  const status = httpStatusFor(appErr.code);

  if (status >= 500) {
    logger.error(
      { event: 'request.error', err: appErr, code: appErr.code, status, path: req.path },
      appErr.message,
    );
  } else {
    logger.warn(
      { event: 'request.client_error', code: appErr.code, status, path: req.path },
      appErr.message,
    );
  }

  res.status(status).json(appErr.toResponseJSON(correlationId));
}

// Re-exported for backwards-compatibility with app.ts; canonical home is ./not-found.ts.
export { notFoundHandler } from './not-found.js';
