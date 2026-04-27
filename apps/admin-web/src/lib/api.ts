/**
 * Browser API client for admin-web.
 *
 * Bearer access token is read from sessionStorage (`yc.admin.access`). The
 * caller MUST already have authenticated as a SUPER_ADMIN; otherwise the
 * server returns 401 and the route guard redirects to /login.
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
const TOKEN_KEY = 'yc.admin.access';

export function getAdminToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setAdminToken(t: string | null): void {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; idempotencyKey?: string; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const token = getAdminToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let url = `${BASE}${path}`;
  if (options.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401) setAdminToken(null);
    throw new ApiError(res.status, parsed as ApiErrorBody);
  }
  return parsed as T;
}
