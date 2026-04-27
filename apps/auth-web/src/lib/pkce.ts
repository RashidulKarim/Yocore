/**
 * Browser PKCE helpers — RFC 7636.
 *
 * `verifier` is 64 random URL-safe chars. `challenge` = base64url(SHA-256(verifier)).
 * Verifier is held in `sessionStorage` so it survives the redirect to /authorize
 * and back to /callback within the same tab.
 */
const SESSION_KEY = 'yc.pkce.verifier';
const STATE_KEY = 'yc.pkce.state';
const SLUG_KEY = 'yc.pkce.product';
const REDIRECT_KEY = 'yc.pkce.redirect';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(digest);
}

export interface BeginPkceArgs {
  productSlug: string;
  redirectUri: string;
}

/** Stash a fresh verifier+state and return the redirect parameters. */
export async function beginPkce(args: BeginPkceArgs): Promise<{
  state: string;
  codeChallenge: string;
}> {
  const verifier = randomString(64);
  const state = randomString(32);
  const codeChallenge = await pkceChallenge(verifier);
  sessionStorage.setItem(SESSION_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(SLUG_KEY, args.productSlug);
  sessionStorage.setItem(REDIRECT_KEY, args.redirectUri);
  return { state, codeChallenge };
}

export interface PkceContext {
  verifier: string;
  state: string;
  productSlug: string;
  redirectUri: string;
}

export function readPkceContext(): PkceContext | null {
  const verifier = sessionStorage.getItem(SESSION_KEY);
  const state = sessionStorage.getItem(STATE_KEY);
  const productSlug = sessionStorage.getItem(SLUG_KEY);
  const redirectUri = sessionStorage.getItem(REDIRECT_KEY);
  if (!verifier || !state || !productSlug || !redirectUri) return null;
  return { verifier, state, productSlug, redirectUri };
}

export function clearPkce(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(SLUG_KEY);
  sessionStorage.removeItem(REDIRECT_KEY);
}
