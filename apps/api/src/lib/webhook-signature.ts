/**
 * HMAC-SHA256 webhook signature: sign + verify with timing-safe equality and
 * a 5-minute timestamp tolerance. See ADR-009.
 *
 * Signature header format (sent in `X-Webhook-Signature`):
 *   t=<unix-seconds>,v1=<hex-hmac>
 *
 * Signed string: `${t}.${rawBody}`  (rawBody MUST be the exact bytes received).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from './errors.js';

export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

export interface SignedHeader {
  /** The full header value to set on the outbound request. */
  header: string;
  timestamp: number;
  signature: string;
}

export function signWebhook(
  rawBody: string,
  secret: string,
  now: Date = new Date(),
): SignedHeader {
  if (!secret) throw new Error('signWebhook: secret is required');
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = computeSignature(timestamp, rawBody, secret);
  return { header: `t=${timestamp},v1=${signature}`, timestamp, signature };
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Override clock for tests. */
  now?: Date;
}

export function verifyWebhook(
  rawBody: string,
  headerValue: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): void {
  if (!secret) throw new Error('verifyWebhook: secret is required');
  if (!headerValue) {
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Missing signature header');
  }
  const parsed = parseHeader(headerValue);
  if (!parsed) {
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Malformed signature header');
  }

  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    throw new AppError(
      ErrorCode.WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE,
      'Webhook timestamp outside tolerance',
    );
  }

  const expected = computeSignature(parsed.timestamp, rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parsed.signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature mismatch');
  }
}

function computeSignature(timestamp: number, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

function parseHeader(value: string): { timestamp: number; signature: string } | undefined {
  const parts = value.split(',').map((p) => p.trim());
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (k === 't') {
      const n = Number(val);
      if (Number.isFinite(n)) t = n;
    } else if (k === 'v1') {
      v1 = val;
    }
  }
  if (t === undefined || !v1) return undefined;
  return { timestamp: t, signature: v1 };
}
