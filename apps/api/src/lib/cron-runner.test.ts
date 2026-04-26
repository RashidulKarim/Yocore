import { describe, it, expect, vi } from 'vitest';
import { CronRunner, type CronJob, type CronLockStore } from './cron-runner.js';

function makeStore(initial: Record<string, boolean> = {}): CronLockStore & {
  acquireMock: ReturnType<typeof vi.fn>;
  releaseMock: ReturnType<typeof vi.fn>;
  state: Record<string, boolean>;
} {
  const state: Record<string, boolean> = { ...initial };
  const acquireMock = vi.fn(async (jobName: string, dateKey: string) => {
    const k = `${jobName}::${dateKey}`;
    if (state[k]) return false;
    state[k] = true;
    return true;
  });
  const releaseMock = vi.fn(async (jobName: string, dateKey: string) => {
    delete state[`${jobName}::${dateKey}`];
  });
  return {
    state,
    acquireMock,
    releaseMock,
    acquire: acquireMock,
    release: releaseMock,
  };
}

function job(handler: () => Promise<void>, name = 'test.job'): CronJob {
  return {
    name,
    schedule: '* * * * *',
    dateKey: () => '2026-01-01T00:00',
    lockTtlMs: 30_000,
    handler,
  };
}

describe('lib/cron-runner', () => {
  it('runs handler when lock acquired', async () => {
    const store = makeStore();
    const runner = new CronRunner({ store });
    const handler = vi.fn(async () => undefined);
    runner.register(job(handler));
    await expect(runner.runOnce('test.job')).resolves.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(store.releaseMock).toHaveBeenCalledOnce();
  });

  it('skips handler when lock not acquired', async () => {
    const store = makeStore({ 'test.job::2026-01-01T00:00': true });
    const runner = new CronRunner({ store });
    const handler = vi.fn(async () => undefined);
    runner.register(job(handler));
    await expect(runner.runOnce('test.job')).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(store.releaseMock).not.toHaveBeenCalled();
  });

  it('returns false and still releases on handler error', async () => {
    const store = makeStore();
    const runner = new CronRunner({ store });
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    runner.register(job(handler));
    await expect(runner.runOnce('test.job')).resolves.toBe(false);
    expect(store.releaseMock).toHaveBeenCalledOnce();
  });

  it('throws on duplicate registration', () => {
    const runner = new CronRunner({ store: makeStore() });
    runner.register(job(async () => {}));
    expect(() => runner.register(job(async () => {}))).toThrow(/already registered/);
  });

  it('throws on unknown job', async () => {
    const runner = new CronRunner({ store: makeStore() });
    await expect(runner.runOnce('does.not.exist')).rejects.toThrow(/unknown job/);
  });

  it('list() returns registered job names', () => {
    const runner = new CronRunner({ store: makeStore() });
    runner.register(job(async () => {}, 'a'));
    runner.register(job(async () => {}, 'b'));
    expect(runner.list()).toEqual(['a', 'b']);
  });

  it('swallows release errors silently', async () => {
    const store = makeStore();
    store.release = vi.fn(async () => {
      throw new Error('release failed');
    });
    const runner = new CronRunner({ store });
    runner.register(job(async () => undefined));
    await expect(runner.runOnce('test.job')).resolves.toBe(true);
  });
});
