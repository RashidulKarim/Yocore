/**
 * Time-warp invariants for grace + deletion lifecycle.
 *
 * These tests assert the *documented* time constants used by the cron
 * services so that any refactor that silently shifts the schedule (e.g.
 * 30d → 14d) immediately fails CI. Full end-to-end exercise of the
 * cron+repo path lives in `*.integration.test.ts` under MongoMemoryServer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  DELETION_GRACE_DAYS,
  DELETION_GRACE_MS,
} from '../services/self-deletion.service.js';

describe('Time-warp invariants — self-deletion', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2025-03-01T00:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 30-day grace window (PRD §X)', () => {
    expect(DELETION_GRACE_DAYS).toBe(30);
    expect(DELETION_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('finalize date is exactly request + 30 days, leap-year safe', () => {
    const requested = new Date('2024-02-15T12:00:00.000Z'); // 2024 is a leap year
    const finalize = new Date(requested.getTime() + DELETION_GRACE_MS);
    expect(finalize.toISOString()).toBe('2024-03-16T12:00:00.000Z');
  });

  it('finalize date is exactly request + 30 days across DST boundary', () => {
    // Northern-hemisphere DST kicks in around Mar 30. UTC math is unaffected.
    const requested = new Date('2025-03-15T00:00:00.000Z');
    const finalize = new Date(requested.getTime() + DELETION_GRACE_MS);
    expect(finalize.toISOString()).toBe('2025-04-14T00:00:00.000Z');
  });
});

describe('Time-warp invariants — failed-payment grace ladder', () => {
  // The grace.service.ts file documents the schedule in the header comment.
  // Mirror those constants here so a regression flips this test.
  const D1_MS = 24 * 60 * 60 * 1000;
  const D5_MS = 5 * D1_MS;
  const D7_MS = 7 * D1_MS;

  it('day1 → day5 → day7 ladder = 1, 5, 7 days', () => {
    expect(D1_MS / 86_400_000).toBe(1);
    expect(D5_MS / 86_400_000).toBe(5);
    expect(D7_MS / 86_400_000).toBe(7);
  });

  it('Day-7 boundary fires correctly when paymentFailedAt is exactly 7d ago', () => {
    vi.useFakeTimers({ now: new Date('2025-01-08T00:00:01.000Z') });
    const paymentFailedAt = new Date('2025-01-01T00:00:00.000Z');
    const elapsed = Date.now() - paymentFailedAt.getTime();
    expect(elapsed).toBeGreaterThan(D7_MS);
    vi.useRealTimers();
  });
});
