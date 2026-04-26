/**
 * 404 fallthrough middleware. Mounted after all routes; before error-handler.
 */
import type { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(ErrorCode.NOT_FOUND, `Route not found: ${req.method} ${req.path}`));
}
