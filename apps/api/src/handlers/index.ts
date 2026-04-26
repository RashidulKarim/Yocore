/**
 * Handler base pattern.
 *
 * RULES (see .github/copilot-instructions.md §2):
 *   - Handlers do three things only:
 *       1. Parse + validate request with a Zod schema from `@yocore/types`.
 *       2. Call exactly one service function.
 *       3. Format the response (status + JSON shape).
 *   - Handlers NEVER touch Mongoose. NEVER hold business logic.
 *   - Always wrap async handlers via `asyncHandler` so thrown AppErrors flow to
 *     the central error middleware.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type AsyncHandler<T extends Request = Request> = (
  req: T,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

/** Wraps an async handler so promise rejections forward to express' error mw. */
export function asyncHandler<T extends Request = Request>(fn: AsyncHandler<T>): RequestHandler {
  return function wrapped(req, res, next): void {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
