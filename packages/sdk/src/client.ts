/**
 * Browser SDK. Two responsibilities:
 *   1. PKCE helpers (Flow F1) — generate verifier+challenge, build /authorize URL,
 *      exchange code for tokens.
 *   2. Authenticated API client backed by an end-user JWT (managed by the host
 *      app; SDK does not persist tokens).
 *
 * Crypto uses the global Web Crypto API (`crypto.subtle`) — works in modern
 * browsers and Node 18+.
 */
import { HttpClient } from './http.js';

export interface YoCoreClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Optional initial JWT to seed the client with. */
  accessToken?: string;
  /** Custom fetch (for testing). */
  fetchImpl?: typeof fetch;
}

export class YoCoreClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private accessToken: string | undefined;
  private readonly http: HttpClient;

  constructor(opts: YoCoreClientOptions) {
    if (!opts.apiKey) throw new Error('YoCoreClient: apiKey required');
    if (!opts.baseUrl) throw new Error('YoCoreClient: baseUrl required');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.accessToken = opts.accessToken;
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      authHeader: () => (this.accessToken ? `Bearer ${this.accessToken}` : undefined),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  // ── PKCE helpers ─────────────────────────────────────────────────────
  /**
   * Generate a fresh PKCE verifier (random 64-byte URL-safe base64).
   * Caller must persist the verifier (e.g. sessionStorage) for the redirect.
   */
  static async createPkceVerifier(): Promise<string> {
    const bytes = new Uint8Array(64);
    cryptoRef().getRandomValues(bytes);
    return base64Url(bytes);
  }

  /** SHA-256 the verifier to get the code_challenge. */
  static async pkceChallenge(verifier: string): Promise<string> {
    const data = new TextEncoder().encode(verifier);
    const digest = await cryptoRef().subtle.digest('SHA-256', data);
    return base64Url(new Uint8Array(digest));
  }

  /** Build the platform `/authorize` redirect URL. */
  buildAuthorizeUrl(input: {
    productSlug: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scope?: string;
  }): string {
    const u = new URL('/v1/auth/authorize', this.baseUrl);
    u.searchParams.set('client_id', this.apiKey);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('product_slug', input.productSlug);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('code_challenge', input.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (input.scope) u.searchParams.set('scope', input.scope);
    return u.toString();
  }

  /** Exchange `code` + the original `verifier` for a token pair. */
  exchangeCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    tokenType: 'Bearer';
  }> {
    return this.http.request({
      method: 'POST',
      path: '/v1/auth/exchange',
      body: {
        code: input.code,
        codeVerifier: input.verifier,
        redirectUri: input.redirectUri,
        clientId: this.apiKey,
      },
    });
  }

  // ── Convenience calls (end-user) ─────────────────────────────────────
  me() {
    return this.http.request<unknown>({ method: 'GET', path: '/v1/users/me' });
  }
  listSessions() {
    return this.http.request<unknown>({ method: 'GET', path: '/v1/sessions' });
  }
  revokeSession(id: string) {
    return this.http.request<unknown>({
      method: 'DELETE',
      path: `/v1/sessions/${encodeURIComponent(id)}`,
    });
  }
  requestSelfDeletion(body: {
    scope: 'account' | 'product';
    productId?: string;
    password: string;
  }) {
    return this.http.request<unknown>({
      method: 'DELETE',
      path: '/v1/users/me',
      body,
    });
  }

  request<T = unknown>(opts: Parameters<HttpClient['request']>[0]) {
    return this.http.request<T>(opts);
  }
}

// ── helpers ────────────────────────────────────────────────────────────
function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  const b64 = typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cryptoRef(): Crypto {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('Web Crypto API unavailable; YoCoreClient requires Node 18+ or a modern browser');
  }
  return globalThis.crypto;
}
