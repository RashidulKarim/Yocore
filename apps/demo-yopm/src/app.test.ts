/**
 * Smoke tests for the demo app — render-only assertions to catch
 * route-mounting and view-helper regressions. Real end-to-end coverage
 * lives in the Playwright suite (`/e2e`) which spins up the full stack.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './index.js';

describe('demo-yopm smoke', () => {
  it('GET /health → 200', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, service: 'demo-yopm' });
  });

  it('GET / → renders landing HTML', async () => {
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('YoPM Demo');
    expect(r.text).toContain('/plans');
  });

  it('GET /signup → form', async () => {
    const r = await request(app).get('/signup');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Create your account');
  });

  it('GET /signin → form', async () => {
    const r = await request(app).get('/signin');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Sign in');
  });

  it('GET /account → 302 to /signin (no session)', async () => {
    const r = await request(app).get('/account');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/signin');
  });

  it('GET /webhooks/log → 200 (in-memory ring)', async () => {
    const r = await request(app).get('/webhooks/log');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Recent webhook events');
  });
});
