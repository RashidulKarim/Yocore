import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { corsMiddleware } from './cors.js';
import { errorHandler } from './error-handler.js';

function build(opts: Parameters<typeof corsMiddleware>[0]) {
  const app = express();
  app.use(corsMiddleware(opts));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('middleware/cors', () => {
  it('passes through when no Origin header (non-browser)', async () => {
    const app = build({ globalAllowOrigins: [] });
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes allowed origin from global list', async () => {
    const app = build({ globalAllowOrigins: ['https://app.yo.test'] });
    const res = await request(app).get('/x').set('Origin', 'https://app.yo.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.yo.test');
    expect(res.headers['vary']).toMatch(/Origin/);
  });

  it('omits ACAO header when origin not allowed', async () => {
    const app = build({ globalAllowOrigins: ['https://app.yo.test'] });
    const res = await request(app).get('/x').set('Origin', 'https://evil.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles preflight 204 with allowed methods + headers', async () => {
    const app = build({ globalAllowOrigins: ['https://app.yo.test'] });
    const res = await request(app)
      .options('/x')
      .set('Origin', 'https://app.yo.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.yo.test');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('rejects preflight from disallowed origin with CORS_ORIGIN_NOT_ALLOWED', async () => {
    const app = build({ globalAllowOrigins: ['https://app.yo.test'] });
    const res = await request(app)
      .options('/x')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CORS_ORIGIN_NOT_ALLOWED');
  });

  it('uses per-product allow-list when resolveProduct returns one', async () => {
    const app = build({
      globalAllowOrigins: [],
      resolveProduct: async () => ({
        productId: 'p1',
        allowedOrigins: ['https://product.test'],
      }),
    });
    const res = await request(app).get('/x').set('Origin', 'https://product.test');
    expect(res.headers['access-control-allow-origin']).toBe('https://product.test');
  });

  it('supports leading-wildcard subdomain matches', async () => {
    const app = build({ globalAllowOrigins: ['*.example.com'] });
    const res = await request(app).get('/x').set('Origin', 'https://api.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://api.example.com');
  });
});
