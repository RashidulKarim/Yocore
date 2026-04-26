/**
 * Injectable clock — services depend on this instead of `Date.now()` so tests
 * can fast-forward via `@sinonjs/fake-timers` or pass an explicit override.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test-only — fixed clock that always returns the given Date. */
export function fixedClock(at: Date): Clock {
  return { now: () => at };
}
