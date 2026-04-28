/**
 * 👉 Thin fetch wrapper for end-user calls. Auto-refreshes the session's
 * accessToken on 401, surfacing a typed { ok, status, body } result so
 * routes can render error flashes without try/catch noise.
 */
import type { Request } from 'express';
import { getSession, setSession, clearSession } from './session.js';

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  error?: string | undefined;
  message?: string | undefined;
}

export interface ApiCallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Send Idempotency-Key (for mutating billing endpoints). */
  idempotencyKey?: string;
}

/** Build absolute URL against YOCORE_BASE_URL. */
function buildUrl(base: string, path: string, query?: ApiCallOpts['query']): string {
  const u = new URL(path, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

export async function rawCall<T = unknown>(
  baseUrl: string,
  path: string,
  opts: ApiCallOpts & { authHeader?: string },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.authHeader) headers.authorization = opts.authHeader;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  let bodyInit: string | undefined;
  if (opts.body !== undefined && (opts.method ?? 'GET') !== 'GET') {
    headers['content-type'] = 'application/json';
    bodyInit = JSON.stringify(opts.body);
  }
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (bodyInit !== undefined) init.body = bodyInit;
  const res = await fetch(buildUrl(baseUrl, path, opts.query), init);
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text };
  }
  const obj = (json ?? {}) as { error?: string; message?: string };
  const result: ApiResult<T> = {
    ok: res.ok,
    status: res.status,
    body: json as T,
  };
  if (obj.error) result.error = obj.error;
  if (obj.message) result.message = obj.message;
  return result;
}

/** Authenticated call using the current session token. Auto-refreshes on 401. */
export async function authCall<T = unknown>(
  baseUrl: string,
  req: Request,
  path: string,
  opts: ApiCallOpts = {},
): Promise<ApiResult<T>> {
  const sess = getSession(req);
  if (!sess?.accessToken) return { ok: false, status: 401, body: {} as T, error: 'NO_SESSION' };

  const first = await rawCall<T>(baseUrl, path, {
    ...opts,
    authHeader: `Bearer ${sess.accessToken}`,
  });
  if (first.status !== 401) return first;

  // attempt refresh
  const refreshed = await rawCall<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    baseUrl,
    '/v1/auth/refresh',
    { method: 'POST', body: { refreshToken: sess.refreshToken } },
  );
  if (!refreshed.ok) {
    clearSession(req);
    return first;
  }
  setSession(req, {
    accessToken: refreshed.body.accessToken,
    refreshToken: refreshed.body.refreshToken,
    expiresAt: Date.now() + refreshed.body.expiresIn * 1000,
  });
  return rawCall<T>(baseUrl, path, {
    ...opts,
    authHeader: `Bearer ${refreshed.body.accessToken}`,
  });
}

/** Unauthenticated call (signup, signin, public plans, etc.). */
export function publicCall<T = unknown>(
  baseUrl: string,
  path: string,
  opts: ApiCallOpts = {},
): Promise<ApiResult<T>> {
  return rawCall<T>(baseUrl, path, opts);
}

/** Make Basic-auth header for server-to-server calls. */
export function basicAuth(apiKey: string, apiSecret: string): string {
  return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`, 'utf8').toString('base64');
}

/** Server-side call with apiKey:apiSecret Basic auth. */
export function serverCall<T = unknown>(
  baseUrl: string,
  apiKey: string,
  apiSecret: string,
  path: string,
  opts: ApiCallOpts = {},
): Promise<ApiResult<T>> {
  return rawCall<T>(baseUrl, path, { ...opts, authHeader: basicAuth(apiKey, apiSecret) });
}

/** Format an ApiResult as a human-readable flash error string. */
export function describeError(r: ApiResult): string {
  return `${r.status} ${r.error ?? ''} ${r.message ?? ''}`.trim();
}
