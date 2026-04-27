/**
 * Shared HTTP helper used by `YoCoreServer` + `YoCoreClient`.
 * - Adds `Idempotency-Key` for non-GET methods when caller supplies one.
 * - Surfaces typed `YoCoreApiError` on non-2xx responses.
 * - Uses native `fetch` (Node 18+ / browser).
 */
import { YoCoreApiError } from './errors.js';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Optional Idempotency-Key for mutating endpoints. */
  idempotencyKey?: string;
  /** Extra headers to merge in (caller-supplied). */
  headers?: Record<string, string>;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface HttpClientConfig {
  baseUrl: string;
  /** Returns the auth header value (e.g. "Bearer ..." or "Basic ..."). */
  authHeader: () => string | undefined;
  /** Static product slug header (server-side flavor only). */
  productSlug?: string | undefined;
  /** Custom fetch impl for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** UA to send on every request. */
  userAgent?: string;
}

export class HttpClient {
  constructor(private readonly cfg: HttpClientConfig) {
    if (!cfg.baseUrl) throw new Error('HttpClient: baseUrl required');
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(opts.path, this.cfg.baseUrl);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    const auth = this.cfg.authHeader();
    if (auth) headers.authorization = auth;
    if (this.cfg.productSlug) headers['x-product-slug'] = this.cfg.productSlug;
    if (this.cfg.userAgent) headers['user-agent'] = this.cfg.userAgent;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    let bodyInit: string | undefined;
    if (opts.body !== undefined && opts.method !== 'GET') {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(opts.body);
    }

    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const init: RequestInit = {
      method: opts.method,
      headers,
    };
    if (bodyInit !== undefined) init.body = bodyInit;
    if (opts.signal !== undefined) init.signal = opts.signal;

    const res = await fetchImpl(url.toString(), init);

    const text = await res.text();
    const json = text.length > 0 ? safeJson(text) : undefined;

    if (!res.ok) {
      const err = (json ?? {}) as {
        error?: string;
        message?: string;
        correlationId?: string;
        details?: unknown;
      };
      throw new YoCoreApiError({
        code: err.error ?? `HTTP_${res.status}`,
        message: err.message ?? res.statusText,
        status: res.status,
        correlationId: err.correlationId,
        details: err.details,
      });
    }
    return (json as T) ?? (undefined as unknown as T);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
