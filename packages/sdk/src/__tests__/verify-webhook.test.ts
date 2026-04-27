import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, WebhookSignatureError } from '../verify-webhook.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'whd_1', type: 'subscription.activated' });

function makeHeader(t: number, body = BODY, secret = SECRET) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = makeHeader(t);
    const r = verifyWebhookSignature(BODY, header, SECRET);
    expect(r.timestamp.getTime() / 1000).toBeCloseTo(t, 0);
  });

  it('accepts headers with reversed order', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = makeHeader(t).split(',').reverse().join(',');
    expect(() => verifyWebhookSignature(BODY, header, SECRET)).not.toThrow();
  });

  it('rejects mismatched signature', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = makeHeader(t).replace(/v1=[a-f0-9]+/, 'v1=' + 'a'.repeat(64));
    expect(() => verifyWebhookSignature(BODY, header, SECRET)).toThrow(WebhookSignatureError);
  });

  it('rejects expired timestamps (> tolerance)', () => {
    const t = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old
    const header = makeHeader(t);
    expect(() => verifyWebhookSignature(BODY, header, SECRET)).toThrow(/expired/);
  });

  it('rejects malformed header', () => {
    expect(() => verifyWebhookSignature(BODY, 'garbage', SECRET)).toThrow();
  });

  it('rejects empty signature header', () => {
    expect(() => verifyWebhookSignature(BODY, undefined, SECRET)).toThrow();
  });

  it('rejects when secret is wrong', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = makeHeader(t);
    expect(() => verifyWebhookSignature(BODY, header, 'wrong')).toThrow(/mismatch/);
  });

  it('accepts a Buffer body', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = makeHeader(t);
    expect(() =>
      verifyWebhookSignature(Buffer.from(BODY, 'utf8'), header, SECRET),
    ).not.toThrow();
  });
});
