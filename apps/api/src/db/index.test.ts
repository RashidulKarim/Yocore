import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import * as db from './index.js';
import { newId } from './id.js';

describe('db model registry', () => {
  it('exports every Phase 2.3 model', () => {
    const expected = [
      'User',
      'ProductUser',
      'Session',
      'AuthToken',
      'MfaFactor',
      'MfaRecoveryRequest',
      'JwtSigningKey',
      'Product',
      'Workspace',
      'WorkspaceMember',
      'Role',
      'Invitation',
      'BillingPlan',
      'Subscription',
      'PaymentGateway',
      'Invoice',
      'Coupon',
      'CouponRedemption',
      'Bundle',
      'UsageRecord',
      'CustomerTaxProfile',
      'PaymentMethodCache',
      'WebhookDelivery',
      'WebhookEventProcessed',
      'CronLock',
      'AuditLog',
      'AuditLogExportJob',
      'EmailQueue',
      'EmailEvent',
      'IdempotencyKey',
      'DataExportJob',
      'DeletionRequest',
      'TosVersion',
      'SuperAdminConfig',
    ];
    for (const name of expected) {
      expect(db, `missing export ${name}`).toHaveProperty(name);
      expect(mongoose.models[name], `model ${name} not registered`).toBeDefined();
    }
  });

  it('produces ULID-prefixed ids via newId/idDefault', () => {
    const id = newId('usr');
    expect(id).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('User schema enforces SUPER_ADMIN partial unique index', () => {
    const idx = db.User.schema.indexes();
    const found = idx.find(
      ([fields, opts]) =>
        (fields as Record<string, unknown>).role === 1 &&
        (opts as { unique?: boolean; partialFilterExpression?: { role?: string } } | undefined)
          ?.unique === true,
    );
    expect(found, 'expected partial unique index on role:SUPER_ADMIN').toBeDefined();
  });

  it('UsageRecord scopes idempotencyKey uniqueness to periodStart (YC-004)', () => {
    const idx = db.UsageRecord.schema.indexes();
    const found = idx.find(([fields, opts]) => {
      const f = fields as Record<string, unknown>;
      return (
        f.subscriptionId === 1 &&
        f.metricName === 1 &&
        f.periodStart === 1 &&
        f.idempotencyKey === 1 &&
        (opts as { unique?: boolean } | undefined)?.unique === true
      );
    });
    expect(found, 'YC-004: unique idem index must include periodStart').toBeDefined();
  });

  it('CustomerTaxProfile uses partialFilterExpression for workspace presence (YC-005)', () => {
    const idx = db.CustomerTaxProfile.schema.indexes();
    const userScoped = idx.find(([fields, opts]) => {
      const f = fields as Record<string, unknown>;
      const o = opts as { partialFilterExpression?: Record<string, unknown> } | undefined;
      return (
        f.userId === 1 &&
        f.productId === 1 &&
        o?.partialFilterExpression !== undefined &&
        JSON.stringify(o.partialFilterExpression).includes('$exists')
      );
    });
    expect(userScoped, 'YC-005: must use $exists partial filter, not sparse').toBeDefined();
  });

  it('SuperAdminConfig is a singleton (default _id)', () => {
    const doc = new db.SuperAdminConfig();
    expect(doc._id).toBe('super_admin_config');
  });
});
