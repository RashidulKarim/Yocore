import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  auditLogMiddleware,
  computeAuditHash,
  canonicalize,
  type AuditLogStore,
  type AuditLogRecord,
} from './audit-log.js';
import { correlationIdMiddleware } from './correlation-id.js';
import { errorHandler } from './error-handler.js';

function makeStore(): AuditLogStore & { records: AuditLogRecord[] } {
  const records: AuditLogRecord[] = [];
  return {
    records,
    async append(body, computeHash) {
      const prevHash = records.length === 0 ? null : (records[records.length - 1]!.hash as string);
      const hash = computeHash(prevHash);
      const rec: AuditLogRecord = { ...body, prevHash, hash };
      records.push(rec);
      return rec;
    },
  };
}

describe('middleware/audit-log', () => {
  it('canonicalize is stable regardless of key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('computeAuditHash chains via prevHash', () => {
    const body = {
      ts: new Date(0),
      productId: null,
      workspaceId: null,
      actor: {
        type: 'system' as const,
        id: null,
        ip: null,
        userAgent: null,
        apiKeyId: null,
        sessionId: null,
        correlationId: null,
      },
      action: 'a',
      resource: { type: null, id: null },
      outcome: 'success' as const,
      reason: null,
      metadata: {},
    };
    const h1 = computeAuditHash(null, body);
    const h2 = computeAuditHash(h1, body);
    expect(h1).not.toBe(h2);
  });

  it('attaches req.audit and chains entries on each call', async () => {
    const store = makeStore();
    const app = express();
    app.use(correlationIdMiddleware);
    app.use(auditLogMiddleware({ store }));
    app.get('/x', async (req, res) => {
      await req.audit!({ action: 'thing.created', outcome: 'success' });
      await req.audit!({ action: 'thing.updated', outcome: 'success' });
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    expect(store.records).toHaveLength(2);
    expect(store.records[0]!.prevHash).toBeNull();
    expect(store.records[1]!.prevHash).toBe(store.records[0]!.hash);
    expect(store.records[0]!.actor.correlationId).toBeTruthy();
  });
});
