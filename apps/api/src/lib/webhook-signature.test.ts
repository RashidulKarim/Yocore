import { describe, it, expect } from 'vitest';
import { signWebhook, verifyWebhook } from './webhook-signature.js';
import { ErrorCode } from './errors.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ event: 'subscription.updated', id: 'evt_1' });

describe('lib/webhook-signature', () => {
  it('signs and verifies a payload within tolerance', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, now);
    expect(signed.header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(() => verifyWebhook(BODY, signed.header, SECRET, { now })).not.toThrow();
  });

  it('rejects missing header', () => {
    expect(() => verifyWebhook(BODY, undefined, SECRET)).toThrowError(
      expect.objectContaining({ code: ErrorCode.WEBHOOK_SIGNATURE_INVALID }),
    );
  });

  it('rejects malformed header (no t/v1)', () => {
    expect(() => verifyWebhook(BODY, 'garbage', SECRET)).toThrowError(
      expect.objectContaining({ code: ErrorCode.WEBHOOK_SIGNATURE_INVALID }),
    );
  });

  it('rejects out-of-tolerance timestamp', () => {
    const past = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, past);
    const future = new Date('2026-04-01T12:10:00Z'); // +10 min > 5 min default
    expect(() => verifyWebhook(BODY, signed.header, SECRET, { now: future })).toThrowError(
      expect.objectContaining({ code: ErrorCode.WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE }),
    );
  });

  it('rejects body tampering', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, now);
    expect(() => verifyWebhook(`${BODY}x`, signed.header, SECRET, { now })).toThrowError(
      expect.objectContaining({ code: ErrorCode.WEBHOOK_SIGNATURE_INVALID }),
    );
  });

  it('rejects wrong secret', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, now);
    expect(() => verifyWebhook(BODY, signed.header, 'whsec_other', { now })).toThrowError(
      expect.objectContaining({ code: ErrorCode.WEBHOOK_SIGNATURE_INVALID }),
    );
  });

  it('throws programmer error on missing secret', () => {
    expect(() => signWebhook(BODY, '')).toThrow(/secret is required/);
    expect(() => verifyWebhook(BODY, 't=1,v1=ab', '')).toThrow(/secret is required/);
  });

  it('respects custom toleranceSeconds', () => {
    const past = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, past);
    const future = new Date('2026-04-01T12:00:30Z'); // +30s
    expect(() =>
      verifyWebhook(BODY, signed.header, SECRET, { now: future, toleranceSeconds: 10 }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE }));
  });

  it('parses header with extra whitespace and reordered fields', () => {
    const now = new Date('2026-04-01T12:00:00Z');
    const signed = signWebhook(BODY, SECRET, now);
    const [tPart, vPart] = signed.header.split(',');
    const reordered = ` ${vPart} , ${tPart} `;
    expect(() => verifyWebhook(BODY, reordered, SECRET, { now })).not.toThrow();
  });
});
