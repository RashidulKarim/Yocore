/**
 * Email-preferences service — Flow AI.
 *
 * Two operations:
 *   - patch():      authenticated user updates their email preferences for
 *                   the currently active product session.
 *   - unsubscribe(): RFC 8058 List-Unsubscribe-Post. Token is an HMAC-signed
 *                   payload `{userId, productId, category, exp}` so the
 *                   one-click endpoint requires no auth and cannot be forged.
 *
 * Token format: base64url(payloadJson) + '.' + base64url(hmacSha256(payload, secret))
 */
import crypto from 'node:crypto';
import { AppError, ErrorCode } from '../lib/errors.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import { systemClock, type Clock } from '../lib/clock.js';

export type EmailCategory = 'marketing' | 'productUpdates' | 'billing' | 'security';

export interface EmailPrefsServiceDeps {
  /** Used to sign unsubscribe tokens (HMAC-SHA256). */
  unsubscribeSecret: string;
  clock?: Clock;
}

export interface PatchInput {
  userId: string;
  productId: string;
  patch: Partial<Record<EmailCategory, boolean>>;
}

export interface UnsubscribePayload {
  u: string; // userId
  p: string; // productId
  c: EmailCategory;
  e: number; // exp (unix seconds)
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64urlDecodeJson<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
}

export function createEmailPrefsService(deps: EmailPrefsServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function patch(input: PatchInput): Promise<{
    emailPreferences: Record<EmailCategory, boolean>;
  }> {
    // Defensive: refuse to disable security mail (transactional security).
    if (input.patch.security === false) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'Security email category cannot be disabled',
      );
    }
    await productUserRepo.patchEmailPreferences(input.productId, input.userId, input.patch);
    const fresh = await productUserRepo.findByUserAndProduct(input.productId, input.userId);
    if (!fresh) throw new AppError(ErrorCode.NOT_FOUND, 'Product user not found');
    const prefs = (fresh.emailPreferences ?? {}) as Record<EmailCategory, boolean>;
    return { emailPreferences: prefs };
  }

  /** Build a signed unsubscribe token (used by the email worker when rendering). */
  function buildUnsubscribeToken(input: {
    userId: string;
    productId: string;
    category: EmailCategory;
    ttlSeconds?: number;
  }): string {
    const exp = Math.floor(clock.now().getTime() / 1000) + (input.ttlSeconds ?? 60 * 60 * 24 * 30);
    const payload: UnsubscribePayload = {
      u: input.userId,
      p: input.productId,
      c: input.category,
      e: exp,
    };
    const body = b64urlJson(payload);
    const sig = crypto
      .createHmac('sha256', deps.unsubscribeSecret)
      .update(body)
      .digest('base64url');
    return `${body}.${sig}`;
  }

  async function unsubscribe(token: string): Promise<{ status: 'unsubscribed'; category: EmailCategory }> {
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid unsubscribe token');
    }
    const [body, sig] = parts as [string, string];
    const expected = crypto
      .createHmac('sha256', deps.unsubscribeSecret)
      .update(body)
      .digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid unsubscribe token');
    }
    let payload: UnsubscribePayload;
    try {
      payload = b64urlDecodeJson<UnsubscribePayload>(body);
    } catch {
      throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Malformed unsubscribe token');
    }
    if (payload.e * 1000 < clock.now().getTime()) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Unsubscribe link expired');
    }
    if (payload.c === 'security') {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'Security category cannot be unsubscribed',
      );
    }
    await productUserRepo.patchEmailPreferences(payload.p, payload.u, { [payload.c]: false });
    return { status: 'unsubscribed', category: payload.c };
  }

  return { patch, unsubscribe, buildUnsubscribeToken };
}

export type EmailPrefsService = ReturnType<typeof createEmailPrefsService>;
