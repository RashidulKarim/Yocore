import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimitMiddleware } from './rate-limit.js';
import { errorHandler } from './error-handler.js';

function build(points: number) {
  const app = express();
  app.set('trust proxy', true);
  app.use(rateLimitMiddleware({ keyPrefix: 'test:rl', points, duration: 60 }));
  app.get('/x', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('middleware/rate-limit', () => {
  it('allows up to N requests then 429s', async () => {
    const app = build(2);
    const r1 = await request(app).get('/x');
    expect(r1.status).toBe(200);
    expect(r1.headers['ratelimit-limit']).toBe('2');
    expect(r1.headers['ratelimit-remaining']).toBe('1');

    const r2 = await request(app).get('/x');
    expect(r2.status).toBe(200);
    expect(r2.headers['ratelimit-remaining']).toBe('0');

    const r3 = await request(app).get('/x');
    expect(r3.status).toBe(429);
    expect(r3.body.error).toBe('RATE_LIMIT_EXCEEDED');
    expect(r3.headers['retry-after']).toBeDefined();
  });
});
