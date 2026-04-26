import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyMiddleware, type ApiKeyProduct } from './api-key.js';
import { errorHandler } from './error-handler.js';
import { hash } from '../lib/password.js';

async function makeApp(product: ApiKeyProduct | null) {
  const app = express();
  app.use(
    apiKeyMiddleware({
      lookupByKey: async (key) => (product && key === product.apiKey ? product : null),
    }),
  );
  app.get('/x', (req, res) => res.json({ productId: req.product?.productId }));
  app.use(errorHandler);
  return app;
}

describe('middleware/api-key', () => {
  it('rejects missing credentials with APIKEY_MISSING', async () => {
    const app = await makeApp(null);
    const res = await request(app).get('/x');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('APIKEY_MISSING');
  });

  it('rejects unknown api key with APIKEY_INVALID', async () => {
    const app = await makeApp(null);
    const res = await request(app)
      .get('/x')
      .set('x-api-key', 'pk_unknown')
      .set('x-api-secret', 'sec');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('APIKEY_INVALID');
  });

  it('rejects bad secret with APIKEY_INVALID', async () => {
    const product: ApiKeyProduct = {
      productId: 'prod_1',
      apiKey: 'pk_test',
      apiSecretHash: await hash('correct-secret'),
      status: 'ACTIVE',
      allowedOrigins: [],
      rateLimitPerMinute: 1000,
    };
    const app = await makeApp(product);
    const res = await request(app)
      .get('/x')
      .set('x-api-key', 'pk_test')
      .set('x-api-secret', 'wrong');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('APIKEY_INVALID');
  });

  it('rejects inactive product with APIKEY_PRODUCT_INACTIVE', async () => {
    const product: ApiKeyProduct = {
      productId: 'prod_1',
      apiKey: 'pk_test',
      apiSecretHash: await hash('s3cret'),
      status: 'INACTIVE',
      allowedOrigins: [],
      rateLimitPerMinute: 1000,
    };
    const app = await makeApp(product);
    const res = await request(app)
      .get('/x')
      .set('x-api-key', 'pk_test')
      .set('x-api-secret', 's3cret');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('APIKEY_PRODUCT_INACTIVE');
  });

  it('attaches req.product on success', async () => {
    const product: ApiKeyProduct = {
      productId: 'prod_42',
      apiKey: 'pk_test',
      apiSecretHash: await hash('s3cret'),
      status: 'ACTIVE',
      allowedOrigins: [],
      rateLimitPerMinute: 1000,
    };
    const app = await makeApp(product);
    const res = await request(app)
      .get('/x')
      .set('x-api-key', 'pk_test')
      .set('x-api-secret', 's3cret');
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe('prod_42');
  });

  it('also accepts Authorization: ApiKey k:s', async () => {
    const product: ApiKeyProduct = {
      productId: 'prod_42',
      apiKey: 'pk_test',
      apiSecretHash: await hash('s3cret'),
      status: 'ACTIVE',
      allowedOrigins: [],
      rateLimitPerMinute: 1000,
    };
    const app = await makeApp(product);
    const res = await request(app).get('/x').set('Authorization', 'ApiKey pk_test:s3cret');
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe('prod_42');
  });
});
