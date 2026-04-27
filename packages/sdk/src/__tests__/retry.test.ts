import { describe, it, expect, vi } from 'vitest';
import { retry } from '../retry.js';
import { YoCoreApiError } from '../errors.js';

describe('retry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await retry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx then succeeds', async () => {
    let n = 0;
    const fn = vi.fn().mockImplementation(async () => {
      n += 1;
      if (n < 3) {
        throw new YoCoreApiError({ code: 'X', message: 'x', status: 503 });
      }
      return 'ok';
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await retry(fn, { sleep, maxAttempts: 5, baseMs: 1, rng: () => 0 });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx (except 429)', async () => {
    const err = new YoCoreApiError({ code: 'X', message: 'x', status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retry(fn, { sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After (numeric seconds)', async () => {
    let n = 0;
    const fn = vi.fn().mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        throw new YoCoreApiError({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'slow down',
          status: 429,
          details: { retryAfter: 2 },
        });
      }
      return 'ok';
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await retry(fn, { sleep, baseMs: 1, rng: () => 0 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('throws after maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(
      new YoCoreApiError({ code: 'X', message: 'x', status: 503 }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retry(fn, { sleep, maxAttempts: 3, baseMs: 1 })).rejects.toBeInstanceOf(
      YoCoreApiError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
