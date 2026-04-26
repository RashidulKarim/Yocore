import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  idempotencyMiddleware,
  type IdempotencyStore,
  type IdempotencyRecord,
} from './idempotency.js';
import { errorHandler } from './error-handler.js';

interface MapEntry {
  state: 'in_progress' | 'complete';
  bodyHash: string;
  record?: IdempotencyRecord;
}

function makeStore(): IdempotencyStore & { entries: Map<string, MapEntry> } {
  const entries = new Map<string, MapEntry>();
  const k = (productId: string | null, scope: string, key: string) =>
    `${productId ?? 'g'}|${scope}|${key}`;
  return {
    entries,
    async acquire({ productId, scope, key, requestBodyHash }) {
      const id = k(productId, scope, key);
      const e = entries.get(id);
      if (!e) {
        entries.set(id, { state: 'in_progress', bodyHash: requestBodyHash });
        return { state: 'acquired' };
      }
      if (e.state === 'in_progress') return { state: 'in_progress' };
      if (e.bodyHash !== requestBodyHash) return { state: 'conflict' };
      return { state: 'replay', record: e.record! };
    },
    async complete({ productId, scope, key, requestBodyHash, responseStatus, responseBody }) {
      entries.set(k(productId, scope, key), {
        state: 'complete',
        bodyHash: requestBodyHash,
        record: { responseStatus, responseBody, requestBodyHash },
      });
    },
    async release({ productId, scope, key }) {
      entries.delete(k(productId, scope, key));
    },
  };
}

function build(store: IdempotencyStore) {
  const app = express();
  app.use(express.json());
  app.post('/x', idempotencyMiddleware({ store, scope: 'test' }), (req, res) => {
    res.status(201).json({ echo: req.body, ts: Date.now() });
  });
  app.use(errorHandler);
  return app;
}

describe('middleware/idempotency', () => {
  it('rejects request without Idempotency-Key', async () => {
    const app = build(makeStore());
    const res = await request(app).post('/x').send({ a: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_MISSING');
  });

  it('rejects malformed Idempotency-Key', async () => {
    const app = build(makeStore());
    const res = await request(app).post('/x').set('Idempotency-Key', 'a').send({ a: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('replays cached response on second call with same body', async () => {
    const store = makeStore();
    const app = build(store);
    const r1 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ a: 1 });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ a: 1 });
    expect(r2.status).toBe(201);
    expect(r2.body.ts).toBe(r1.body.ts);
  });

  it('rejects with IDEMPOTENCY_KEY_CONFLICT when body differs', async () => {
    const store = makeStore();
    const app = build(store);
    await request(app).post('/x').set('Idempotency-Key', 'idem-key-12345').send({ a: 1 });
    const r = await request(app)
      .post('/x')
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ a: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});
