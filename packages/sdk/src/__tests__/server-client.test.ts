import { describe, it, expect, vi } from 'vitest';
import { YoCoreServer } from '../server.js';
import { YoCoreClient } from '../client.js';
import { YoCoreApiError } from '../errors.js';

function fakeFetch(handler: (req: { url: string; init: RequestInit }) => Response) {
  return vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    return handler({ url, init });
  }) as unknown as typeof fetch;
}

describe('YoCoreServer', () => {
  it('sends Basic auth + Idempotency-Key + JSON body', async () => {
    const captured: { url: string; init: RequestInit } = { url: '', init: {} };
    const fetchImpl = fakeFetch(({ url, init }) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const sdk = new YoCoreServer({
      apiKey: 'pk_test',
      apiSecret: 'sk_test',
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });
    await sdk.changePlan('prd_1', 'sub_1', { newPlanId: 'pln_2' }, 'idem_1');
    expect(captured.url).toBe('https://api.example.com/v1/products/prd_1/subscriptions/sub_1/change-plan');
    const headers = captured.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    expect(headers['idempotency-key']).toBe('idem_1');
    expect(captured.init.body).toBe(JSON.stringify({ newPlanId: 'pln_2' }));
  });

  it('throws YoCoreApiError on non-2xx', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'NOT_FOUND', message: 'gone', correlationId: 'cid_1' }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    const sdk = new YoCoreServer({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });
    await expect(sdk.listPlans('demo')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      correlationId: 'cid_1',
    });
  });

  it('rejects without apiKey/apiSecret', () => {
    expect(
      () =>
        new YoCoreServer({
          apiKey: '',
          apiSecret: 's',
          baseUrl: 'https://x',
        }),
    ).toThrow();
  });
});

describe('YoCoreClient', () => {
  it('PKCE verifier + challenge are URL-safe', async () => {
    const v = await YoCoreClient.createPkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    const c = await YoCoreClient.pkceChallenge(v);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c).not.toBe(v);
  });

  it('buildAuthorizeUrl includes required PKCE params', () => {
    const c = new YoCoreClient({ apiKey: 'pk', baseUrl: 'https://api.example.com' });
    const url = new URL(
      c.buildAuthorizeUrl({
        productSlug: 'demo',
        redirectUri: 'https://app.example.com/cb',
        state: 's1',
        codeChallenge: 'cc',
      }),
    );
    expect(url.searchParams.get('client_id')).toBe('pk');
    expect(url.searchParams.get('code_challenge')).toBe('cc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('product_slug')).toBe('demo');
  });

  it('sends Bearer when access token is set', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = fakeFetch(({ init }) => {
      captured = init.headers as Record<string, string>;
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const c = new YoCoreClient({
      apiKey: 'pk',
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });
    c.setAccessToken('jwt_abc');
    await c.me();
    expect(captured.authorization).toBe('Bearer jwt_abc');
  });

  it('throws when constructed without baseUrl', () => {
    expect(() => new YoCoreClient({ apiKey: 'k', baseUrl: '' })).toThrow();
  });

  it('parses ApiError on error response', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: 'AUTH_INVALID_TOKEN', message: 'no' }), {
          status: 401,
        }),
    );
    const c = new YoCoreClient({
      apiKey: 'pk',
      baseUrl: 'https://api.example.com',
      fetchImpl,
    });
    c.setAccessToken('expired');
    await expect(c.me()).rejects.toBeInstanceOf(YoCoreApiError);
  });
});
