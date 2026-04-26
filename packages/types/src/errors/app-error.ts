import { ErrorCode } from './error-codes.js';

/**
 * AppError — every error thrown from handlers/services should be an instance of this.
 *
 * The central error-handler middleware in `apps/api` translates AppError to:
 *   { error: <code>, message: <user-friendly>, correlationId, details? }
 *
 * Unknown errors are converted to AppError(INTERNAL_ERROR) with the original cause logged.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;
  public override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, cause?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.cause = cause;
    // Preserve stack across async boundaries
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }

  /** Convenience: create from an unknown caught value. */
  static from(err: unknown, fallbackCode: ErrorCode = ErrorCode.INTERNAL_ERROR): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof Error) return new AppError(fallbackCode, err.message, undefined, err);
    return new AppError(fallbackCode, 'Unknown error', undefined, err);
  }

  /** JSON-safe representation for response body. correlationId added by middleware. */
  toResponseJSON(correlationId?: string) {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(correlationId ? { correlationId } : {}),
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
