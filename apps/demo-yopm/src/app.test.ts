/**
 * demo-yopm route tests — all 7 routes, all major branches.
 *
 * Uses Vitest + supertest. The SDK is fully mocked so no real YoCore API is needed.
 *
 * Routes covered:
 *   GET  /health          — always 200
 *   GET  /                — HTML home page
 *   GET  /login           — PKCE start → 302 redirect
 *   GET  /callback        — code exchange → tokens (success + error branches)
 *   GET  /me              — fetch profile (authed + 401 branch)
 *   GET  /plans           — list plans via API key (success + 502 branch)
 *   POST /webhooks        — HMAC verify (valid + invalid signature + missing sig)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// SDK mock — must be declared before the dynamic import of the app module.
// ---------------------------------------------------------------------------
const mockBuildAuthorizeUrl = vi.fn().mockReturnValue('https://yocore.test/authorize?state=abc');
const mockExchangeCode = vi.fn().mockResolvedValue({ accessToken: 'tok_test_access' });
const mockMe = vi.fn().mockResolvedValue({ id: 'usr_123', email: 'alice@test.com' });
const mockSetAccessToken = vi.fn();
const mockListPlans = vi.fn().mockResolvedValue([
  { id: 'plan_basic', name: 'Basic', amount: 1000, currency: 'usd' },
]);
const mockVerifyWebhookSignature = vi.fn();

vi.mock('@yocore/sdk', () => {
  class MockYoCoreClient {
    static async createPkceVerifier() {
      return 'mock_verifier';
    }
    static async pkceChallenge(_v: string) {
      return 'mock_challenge';
    }
    setAccessToken(t: string) {
      mockSetAccessToken(t);
    }
    buildAuthorizeUrl(opts: unknown) {
      return mockBuildAuthorizeUrl(opts);
    }
    async exchangeCode(opts: unknown) {
      return mockExchangeCode(opts);
    }
    async me() {
      return mockMe();
    }
  }

  class MockYoCoreServer {
    async listPlans(slug: string) {
      return mockListPlans(slug);
    }
  }

  class WebhookSignatureError extends Error {
    readonly reason: string;
    constructor(reason: string, msg?: string) {
      super(msg ?? reason);
      this.name = 'WebhookSignatureError';
      this.reason = reason;
    }
  }

  function verifyWebhookSignature(body: Buffer, sig: string | undefined, secret: string) {
    return mockVerifyWebhookSignature(body, sig, secret);
  }

  return {
    YoCoreClient: MockYoCoreClient,
    YoCoreServer: MockYoCoreServer,
    verifyWebhookSignature,
    WebhookSignatureError,
  };
});

// Import AFTER the mock is in place. NODE_ENV=test guards app.listen().
process.env['NODE_ENV'] = 'test';
process.env['YOCORE_WEBHOOK_SECRET'] = 'whsec_test_secret_32bytes_long!!';
const { app } = await import('./index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeWebhookSig(body: string, secret: string, tsDelta = 0): string {
  const ts = Math.floor(Date.now() / 1000) + tsDelta;
  const payload = `${ts}.${body}`;
  const mac = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${ts},v1=${mac}`;
}

// ---------------------------------------------------------------------------
describe('GET /health', () => {
  it('returns 200 { ok: true }', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, service: 'demo-yopm' });
  });
});

describe('GET /', () => {
  it('returns HTML home with login link', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('/login');
    expect(res.text).toContain('/plans');
  });
});

describe('GET /login', () => {
  it('redirects to the authorize URL built by the SDK', async () => {
    mockBuildAuthorizeUrl.mockReturnValueOnce('https://yocore.test/authorize?ok=1');
    const res = await request(app).get('/login').expect(302);
    expect(res.headers['location']).toBe('https://yocore.test/authorize?ok=1');
    expect(mockBuildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        productSlug: expect.any(String),
        codeChallenge: 'mock_challenge',
        scope: 'profile billing',
      }),
    );
  });
});

describe('GET /callback', () => {
  it('exchanges code and returns HTML on success', async () => {
    // First trigger /login to seed a pkce state entry, then do a second
    // call intercepting buildAuthorizeUrl to capture the state.
    let capturedState = '';
    mockBuildAuthorizeUrl.mockImplementationOnce((opts: { state: string }) => {
      capturedState = opts.state;
      return `https://yocore.test/authorize?state=${opts.state}`;
    });
    await request(app).get('/login'); // seeds pkceStore with capturedState
    mockExchangeCode.mockResolvedValueOnce({ accessToken: 'tok_abc' });

    const res = await request(app)
      .get(`/callback?code=auth_code_123&state=${capturedState}`)
      .expect(200);
    expect(res.text).toContain('Signed in');
    expect(res.text).toContain(`/me?s=${capturedState}`);
    expect(mockExchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth_code_123', verifier: 'mock_verifier' }),
    );
  });

  it('returns 400 when state is unknown', async () => {
    const res = await request(app)
      .get('/callback?code=x&state=no_such_state')
      .expect(400);
    expect(res.text).toContain('Missing or unknown state/code');
  });

  it('returns 500 when SDK exchangeCode throws', async () => {
    mockBuildAuthorizeUrl.mockImplementationOnce((opts: { state: string }) => {
      return `https://yocore.test/authorize?state=${opts.state}`;
    });
    let capturedState = '';
    mockBuildAuthorizeUrl.mockImplementationOnce((opts: { state: string }) => {
      capturedState = opts.state;
      return `https://yocore.test/authorize?state=${opts.state}`;
    });
    await request(app).get('/login');
    mockExchangeCode.mockRejectedValueOnce(new Error('token endpoint down'));

    const res = await request(app)
      .get(`/callback?code=bad_code&state=${capturedState}`)
      .expect(500);
    expect(res.text).toContain('Exchange failed');
  });
});

describe('GET /me', () => {
  it('returns 401 when session token is unknown', async () => {
    const res = await request(app).get('/me?s=no_session').expect(401);
    expect(res.text).toContain('Not signed in');
  });

  it('returns user JSON when session is valid', async () => {
    // Seed a session: complete a login+callback cycle.
    let capturedState = '';
    mockBuildAuthorizeUrl.mockImplementationOnce((opts: { state: string }) => {
      capturedState = opts.state;
      return `https://yocore.test/authorize?state=${opts.state}`;
    });
    await request(app).get('/login');
    mockExchangeCode.mockResolvedValueOnce({ accessToken: 'tok_me_test' });
    await request(app).get(`/callback?code=c&state=${capturedState}`);

    mockMe.mockResolvedValueOnce({ id: 'usr_alice', email: 'alice@example.com' });
    const res = await request(app).get(`/me?s=${capturedState}`).expect(200);
    expect(res.body).toMatchObject({ id: 'usr_alice', email: 'alice@example.com' });
  });

  it('returns 502 when SDK me() throws', async () => {
    let capturedState = '';
    mockBuildAuthorizeUrl.mockImplementationOnce((opts: { state: string }) => {
      capturedState = opts.state;
      return `https://yocore.test/authorize?state=${opts.state}`;
    });
    await request(app).get('/login');
    mockExchangeCode.mockResolvedValueOnce({ accessToken: 'tok_502' });
    await request(app).get(`/callback?code=c&state=${capturedState}`);

    mockMe.mockRejectedValueOnce(new Error('YoCore unreachable'));
    const res = await request(app).get(`/me?s=${capturedState}`).expect(502);
    expect(res.text).toContain('me failed');
  });
});

describe('GET /plans', () => {
  beforeEach(() => {
    mockListPlans.mockResolvedValue([{ id: 'plan_basic', name: 'Basic', amount: 1000 }]);
  });

  it('returns plan list from SDK', async () => {
    const res = await request(app).get('/plans').expect(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body[0]).toMatchObject({ id: 'plan_basic' });
  });

  it('returns 502 when SDK listPlans throws', async () => {
    mockListPlans.mockRejectedValueOnce(new Error('upstream error'));
    const res = await request(app).get('/plans').expect(502);
    expect(res.text).toContain('listPlans failed');
  });
});

describe('POST /webhooks', () => {
  const secret = 'whsec_test_secret_32bytes_long!!';

  it('returns 200 { received: true } for valid HMAC signature', async () => {
    const body = JSON.stringify({ type: 'subscription.created', data: {} });
    mockVerifyWebhookSignature.mockReturnValueOnce({ timestamp: 1700000000 });
    const sig = makeWebhookSig(body, secret);

    const res = await request(app)
      .post('/webhooks')
      .set('content-type', 'application/json')
      .set('x-yocore-signature', sig)
      .send(Buffer.from(body))
      .expect(200);
    expect(res.body).toMatchObject({ received: true });
    expect(mockVerifyWebhookSignature).toHaveBeenCalled();
  });

  it('returns 401 when signature is invalid', async () => {
    const { WebhookSignatureError } = await import('@yocore/sdk');
    const body = JSON.stringify({ type: 'foo' });
    mockVerifyWebhookSignature.mockImplementationOnce(() => {
      throw new WebhookSignatureError('expired', 'timestamp out of tolerance');
    });

    const res = await request(app)
      .post('/webhooks')
      .set('content-type', 'application/json')
      .set('x-yocore-signature', 'bad_sig')
      .send(Buffer.from(body))
      .expect(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(res.body.detail).toContain('timestamp');
  });

  it('returns 401 when x-yocore-signature header is missing', async () => {
    const { WebhookSignatureError } = await import('@yocore/sdk');
    const body = JSON.stringify({ type: 'foo' });
    mockVerifyWebhookSignature.mockImplementationOnce(() => {
      throw new WebhookSignatureError('malformed', 'missing signature');
    });

    const res = await request(app)
      .post('/webhooks')
      .set('content-type', 'application/json')
      .send(Buffer.from(body))
      .expect(401);
    expect(res.body.error).toBe('invalid_signature');
  });
});
