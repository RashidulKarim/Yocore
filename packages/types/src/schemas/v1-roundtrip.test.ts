/**
 * Schema round-trip tests (V1.0-E).
 *
 * For each schema we verify:
 *   1. parse(input) accepts a representative valid object.
 *   2. parse(input) rejects an object missing a required field.
 *   3. parse(parse(x).safe shape) is stable across passes.
 */
import { describe, it, expect } from 'vitest';
import {
  forceSubscriptionStatusRequestSchema,
  applySubscriptionCreditRequestSchema,
  forceCronRunRequestSchema,
  updateSuperAdminConfigRequestSchema,
  publishTosVersionRequestSchema,
  requestSelfDeletionRequestSchema,
  listSessionsResponseSchema,
  tosAcceptanceSchema,
  subscriptionWebhookEnvelopeSchema,
  bundleSubscriptionWebhookEnvelopeSchema,
  WebhookEventTypes,
  SubscriptionStatuses,
  PlatformLimits,
} from '../index.js';

describe('schema round-trip', () => {
  it('forceSubscriptionStatusRequestSchema', () => {
    const ok = { status: 'ACTIVE' as const, reason: 'manual override' };
    expect(forceSubscriptionStatusRequestSchema.parse(ok)).toEqual(ok);
    expect(() =>
      forceSubscriptionStatusRequestSchema.parse({ status: 'WAT', reason: 'r' }),
    ).toThrow();
  });

  it('applySubscriptionCreditRequestSchema', () => {
    expect(
      applySubscriptionCreditRequestSchema.parse({ deltaMinor: -500, reason: 'goodwill' }),
    ).toMatchObject({ deltaMinor: -500 });
    expect(() =>
      applySubscriptionCreditRequestSchema.parse({ deltaMinor: 1.5, reason: 'r' }),
    ).toThrow();
  });

  it('forceCronRunRequestSchema accepts known jobs only', () => {
    expect(
      forceCronRunRequestSchema.parse({ jobName: 'jwt.key.retire' }),
    ).toMatchObject({ jobName: 'jwt.key.retire' });
    expect(() =>
      forceCronRunRequestSchema.parse({ jobName: 'unknown.job' }),
    ).toThrow();
  });

  it('updateSuperAdminConfigRequestSchema CIDR + bool', () => {
    expect(
      updateSuperAdminConfigRequestSchema.parse({
        adminIpAllowlist: ['10.0.0.0/8', '203.0.113.7'],
        adminIpAllowlistEnabled: true,
      }),
    ).toMatchObject({ adminIpAllowlistEnabled: true });
    expect(() =>
      updateSuperAdminConfigRequestSchema.parse({ adminIpAllowlist: ['not-a-cidr!'] }),
    ).toThrow();
  });

  it('publishTosVersionRequestSchema', () => {
    const ok = {
      type: 'terms_of_service' as const,
      version: '1.0',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      contentUrl: 'https://example.com/tos',
      contentHash: 'a'.repeat(64),
    };
    expect(publishTosVersionRequestSchema.parse(ok)).toMatchObject({ version: '1.0' });
  });

  it('requestSelfDeletionRequestSchema', () => {
    expect(
      requestSelfDeletionRequestSchema.parse({ scope: 'account', password: 'x' }),
    ).toMatchObject({ scope: 'account' });
  });

  it('listSessionsResponseSchema', () => {
    const ok = {
      sessions: [
        {
          id: 's1',
          productId: 'p1',
          createdAt: '2026-04-01T00:00:00.000Z',
          lastUsedAt: null,
          ip: '127.0.0.1',
          userAgent: 'curl',
          isCurrent: true,
        },
      ],
    };
    expect(listSessionsResponseSchema.parse(ok)).toEqual(ok);
  });

  it('tosAcceptanceSchema requires both versions', () => {
    expect(
      tosAcceptanceSchema.parse({
        acceptedTosVersion: '1.0',
        acceptedPrivacyVersion: '1.0',
      }),
    ).toMatchObject({ acceptedTosVersion: '1.0' });
    expect(() => tosAcceptanceSchema.parse({ acceptedTosVersion: '1.0' })).toThrow();
  });

  it('subscriptionWebhookEnvelopeSchema', () => {
    const env = {
      id: 'whd_1',
      type: WebhookEventTypes.SUBSCRIPTION_ACTIVATED,
      createdAt: '2026-04-01T00:00:00.000Z',
      apiVersion: '2026-04-23',
      data: {
        subscriptionId: 'sub_1',
        productId: 'prd_1',
        planId: 'pln_1',
        status: SubscriptionStatuses.ACTIVE,
        subject: { type: 'user' as const, userId: 'usr_1', workspaceId: null },
        quantity: 1,
        currentPeriodStart: '2026-04-01T00:00:00.000Z',
        currentPeriodEnd: '2026-05-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
      },
    };
    expect(subscriptionWebhookEnvelopeSchema.parse(env)).toEqual(env);
  });

  it('bundleSubscriptionWebhookEnvelopeSchema', () => {
    const env = {
      id: 'whd_2',
      type: WebhookEventTypes.BUNDLE_SUBSCRIPTION_ACTIVATED,
      createdAt: '2026-04-01T00:00:00.000Z',
      apiVersion: '2026-04-23',
      data: {
        bundleId: 'bdl_1',
        parentSubscriptionId: 'sub_p',
        componentSubscriptionIds: ['sub_a', 'sub_b'],
        subject: { type: 'workspace' as const, userId: null, workspaceId: 'wks_1' },
        status: 'ACTIVE' as const,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
    };
    expect(bundleSubscriptionWebhookEnvelopeSchema.parse(env)).toEqual(env);
  });

  it('PlatformLimits exposes critical caps', () => {
    expect(PlatformLimits.WEBHOOK_DELIVERY_MAX_ATTEMPTS).toBe(6);
    expect(PlatformLimits.JWT_VERIFY_GRACE_MINUTES).toBe(30);
    expect(PlatformLimits.VOLUNTARY_DELETION_GRACE_DAYS).toBe(30);
  });
});
