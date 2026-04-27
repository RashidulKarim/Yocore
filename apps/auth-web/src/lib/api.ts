/**
 * Tiny browser-side fetch wrapper around the YoCore API.
 *
 * The full SDK is server-side; auth-web stays thin and posts directly so the
 * bundle remains small. Errors throw `ApiError` with the API's `error` code.
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  correlationId?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly correlationId: string | undefined;
  readonly details: unknown;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.code = body.error ?? 'UNKNOWN';
    this.status = status;
    this.correlationId = body.correlationId;
    this.details = body.details;
  }
}

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; bearer?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, parsed as ApiErrorBody);
  }
  return parsed as T;
}
