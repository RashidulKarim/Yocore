import { describe, it, expect, beforeEach } from 'vitest';
import { register } from 'prom-client';
import { createBreaker } from './circuit-breaker.js';
import { AppError, ErrorCode } from './errors.js';

describe('lib/circuit-breaker', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('returns the action result on success', async () => {
    const breaker = createBreaker(async (x: number) => x * 2, { name: 'cb_success' });
    await expect(breaker.fire(21)).resolves.toBe(42);
  });

  it('rethrows AppError untouched', async () => {
    const breaker = createBreaker(
      async () => {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'bad input');
      },
      { name: 'cb_apperror' },
    );
    await expect(breaker.fire()).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('wraps generic upstream errors as SERVICE_UNAVAILABLE', async () => {
    const breaker = createBreaker(
      async () => {
        throw new Error('socket hang up');
      },
      { name: 'cb_generic', volumeThreshold: 1000 },
    );
    await expect(breaker.fire()).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
  });

  it('opens the circuit after enough failures and fails fast with CIRCUIT_OPEN', async () => {
    const breaker = createBreaker(
      async () => {
        throw new Error('always fails');
      },
      {
        name: 'cb_open',
        timeoutMs: 200,
        errorThresholdPercentage: 1,
        resetTimeoutMs: 60_000,
        rollingWindowMs: 1_000,
        rollingBuckets: 1,
      },
    );

    // Trip the circuit.
    for (let i = 0; i < 5; i++) {
      await expect(breaker.fire()).rejects.toBeInstanceOf(AppError);
    }
    expect(breaker.raw.opened).toBe(true);

    // Subsequent call should fast-fail with CIRCUIT_OPEN.
    await expect(breaker.fire()).rejects.toMatchObject({
      code: ErrorCode.BILLING_GATEWAY_CIRCUIT_OPEN,
    });
  });

  it('classifies opossum timeouts as SERVICE_UNAVAILABLE', async () => {
    const breaker = createBreaker(
      () => new Promise<never>(() => {}), // never resolves
      { name: 'cb_timeout', timeoutMs: 20, volumeThreshold: 1000 },
    );
    await expect(breaker.fire()).rejects.toMatchObject({ code: ErrorCode.SERVICE_UNAVAILABLE });
  });

  it('honours shouldNotCount filter', async () => {
    let calls = 0;
    const breaker = createBreaker(
      async () => {
        calls += 1;
        const e = new Error('ignore me') as Error & { expected?: boolean };
        e.expected = true;
        throw e;
      },
      {
        name: 'cb_filter',
        errorThresholdPercentage: 1,
        rollingBuckets: 1,
        rollingWindowMs: 1_000,
        shouldNotCount: (err) => Boolean((err as { expected?: boolean }).expected),
      },
    );

    for (let i = 0; i < 10; i++) {
      await expect(breaker.fire()).rejects.toBeInstanceOf(AppError);
    }
    // Filtered errors must not open the breaker.
    expect(breaker.raw.opened).toBe(false);
    expect(calls).toBe(10);
  });
});
