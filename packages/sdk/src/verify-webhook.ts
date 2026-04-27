/**
 * Outbound webhook signature verification.
 *
 * The platform signs each delivery's raw JSON body with a per-product secret.
 * Header format (X-YoCore-Signature):
 *
 *   t=<unix-seconds>,v1=<hex-sha256>
 *
 * `v1` is the lowercase hex of HMAC-SHA256 over the literal string
 * `${t}.${rawBody}` using the product's webhook secret.
 *
 * Verifier responsibilities:
 *   - parse + tolerate ordering ("v1=...,t=...")
 *   - constant-time compare via `crypto.timingSafeEqual`
 *   - reject if |now - t| > toleranceMs (default 5 min — replay protection)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyWebhookSignatureOptions {
  /** Tolerance window for the `t` (timestamp) claim. Default 5 minutes. */
  toleranceMs?: number;
  /** Override "now" for tests. */
  now?: () => Date;
}

export class WebhookSignatureError extends Error {
  readonly reason:
    | 'malformed'
    | 'no_v1'
    | 'no_timestamp'
    | 'invalid_timestamp'
    | 'expired'
    | 'mismatch';
  constructor(reason: WebhookSignatureError['reason'], message?: string) {
    super(message ?? reason);
    this.name = 'WebhookSignatureError';
    this.reason = reason;
  }
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
  opts: VerifyWebhookSignatureOptions = {},
): { timestamp: Date } {
  if (!signatureHeader) throw new WebhookSignatureError('malformed', 'missing signature');
  const parts = String(signatureHeader)
    .split(',')
    .map((p) => p.trim());
  let t: string | undefined;
  let v1: string | undefined;
  for (const p of parts) {
    const [k, v] = splitOnce(p, '=');
    if (k === 't') t = v;
    else if (k === 'v1') v1 = v;
  }
  if (!t) throw new WebhookSignatureError('no_timestamp');
  if (!v1) throw new WebhookSignatureError('no_v1');
  const ts = Number(t);
  if (!Number.isFinite(ts) || ts <= 0) throw new WebhookSignatureError('invalid_timestamp');

  const now = opts.now ? opts.now().getTime() : Date.now();
  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (Math.abs(now - ts * 1000) > tolerance) {
    throw new WebhookSignatureError('expired');
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${bodyStr}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookSignatureError('mismatch');
  }
  return { timestamp: new Date(ts * 1000) };
}

function splitOnce(s: string, sep: string): [string, string] {
  const idx = s.indexOf(sep);
  if (idx < 0) return [s, ''];
  return [s.slice(0, idx), s.slice(idx + 1)];
}
