import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createNoopAppContext } from '../test/test-context.js';

describe('createApp smoke', () => {
  const app = createApp({ ctx: createNoopAppContext() });

  it('GET /v1/health returns 200 with status ok', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('attaches x-correlation-id response header', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.headers['x-request-id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('echoes incoming valid x-correlation-id', async () => {
    const cid = '01H8ZQK5N9V8KQYR4M0Q9V8KQR';
    const res = await request(app).get('/v1/health').set('x-correlation-id', cid);
    expect(res.headers['x-correlation-id']).toBe(cid);
  });

  it('returns RESOURCE_NOT_FOUND with correlationId for unknown routes', async () => {
    const res = await request(app).get('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.correlationId).toBeTruthy();
  });

  it('disables x-powered-by header', async () => {
    const res = await request(app).get('/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
