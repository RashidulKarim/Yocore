/**
 * OpenAPI document smoke test (V1.0-J).
 *
 * Verifies that buildOpenApiDocument() produces a 3.1 spec, includes the
 * critical V1.0 routes, and emits security schemes.
 */
import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';

describe('OpenAPI spec', () => {
  const doc = buildOpenApiDocument();

  it('reports 3.1 + info', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toMatch(/YoCore/);
    expect(doc.info.version).toBe('1.0.0');
  });

  it('declares bearer + basic security schemes', () => {
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
    });
  });

  it('contains the V1.0 critical routes', () => {
    const paths = Object.keys(doc.paths ?? {});
    for (const required of [
      '/v1/auth/signup',
      '/v1/auth/signin',
      '/v1/users/me',
      '/v1/sessions',
      '/v1/admin/jwt/rotate-key',
      '/v1/admin/webhook-deliveries',
      '/v1/admin/tos',
      '/v1/tos/current',
    ]) {
      expect(paths, `missing ${required}`).toContain(required);
    }
  });

  it('caches across calls (same instance)', () => {
    expect(buildOpenApiDocument()).toBe(doc);
  });
});
