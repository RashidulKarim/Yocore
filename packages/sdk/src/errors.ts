/**
 * SDK error wrapper. Mirrors the API's JSON error envelope:
 *   { error: <code>, message: <string>, correlationId?: <string>, details?: any }
 */
export class YoCoreApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | undefined;
  readonly details: unknown;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    correlationId?: string | undefined;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'YoCoreApiError';
    this.code = input.code;
    this.status = input.status;
    this.correlationId = input.correlationId;
    this.details = input.details;
  }
}

export function isYoCoreApiError(err: unknown): err is YoCoreApiError {
  return err instanceof YoCoreApiError;
}
