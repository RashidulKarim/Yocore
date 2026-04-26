/**
 * Circuit-breaker factory: opossum + Prometheus gauges.
 *
 * Use this to wrap any outbound dependency (Stripe, SSLCommerz, Resend, etc.).
 * Failures past `errorThresholdPercentage` over a rolling window open the
 * circuit; subsequent calls fail fast with AppError until the breaker
 * half-opens.
 */
import CircuitBreaker, { type Options as OpossumOptions } from 'opossum';
import { Gauge, Counter, register } from 'prom-client';
import { AppError, ErrorCode } from './errors.js';

export interface BreakerConfig {
  /** Stable name for metrics + logs. */
  name: string;
  /** Per-call timeout (ms). Defaults to 10s. */
  timeoutMs?: number;
  /** % of failures that opens the circuit. Defaults to 50%. */
  errorThresholdPercentage?: number;
  /** Cool-down before half-open (ms). Defaults to 30s. */
  resetTimeoutMs?: number;
  /** Rolling stats window (ms). Defaults to 30s. */
  rollingWindowMs?: number;
  /** Number of buckets in the window. Defaults to 10. */
  rollingBuckets?: number;
  /** Minimum number of calls in the rolling window before opening. Defaults to 0 (opossum default). */
  volumeThreshold?: number;
  /** Map any error code that should be classified as "expected" → not counted toward open. */
  shouldNotCount?: (err: unknown) => boolean;
}

export interface BreakerHandle<TArgs extends unknown[], TResult> {
  fire(...args: TArgs): Promise<TResult>;
  /** Underlying opossum instance — exposed for tests / advanced wiring. */
  raw: CircuitBreaker<TArgs, TResult>;
}

const stateGauge = lazyGauge(
  'yocore_circuit_state',
  'Circuit breaker state (0=closed, 1=halfOpen, 2=open)',
  ['name'],
);
const callsCounter = lazyCounter('yocore_circuit_calls_total', 'Total calls through breaker', [
  'name',
  'outcome',
]);

export function createBreaker<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  config: BreakerConfig,
): BreakerHandle<TArgs, TResult> {
  const opts: OpossumOptions = {
    timeout: config.timeoutMs ?? 10_000,
    errorThresholdPercentage: config.errorThresholdPercentage ?? 50,
    resetTimeout: config.resetTimeoutMs ?? 30_000,
    rollingCountTimeout: config.rollingWindowMs ?? 30_000,
    rollingCountBuckets: config.rollingBuckets ?? 10,
    volumeThreshold: config.volumeThreshold ?? 0,
    name: config.name,
    ...(config.shouldNotCount ? { errorFilter: config.shouldNotCount } : {}),
  };

  const breaker = new CircuitBreaker<TArgs, TResult>(action, opts);

  breaker.on('open', () => stateGauge?.set({ name: config.name }, 2));
  breaker.on('halfOpen', () => stateGauge?.set({ name: config.name }, 1));
  breaker.on('close', () => stateGauge?.set({ name: config.name }, 0));
  breaker.on('success', () => callsCounter?.inc({ name: config.name, outcome: 'success' }));
  breaker.on('failure', () => callsCounter?.inc({ name: config.name, outcome: 'failure' }));
  breaker.on('timeout', () => callsCounter?.inc({ name: config.name, outcome: 'timeout' }));
  breaker.on('reject', () => callsCounter?.inc({ name: config.name, outcome: 'reject' }));
  // Initialise the gauge to closed so it shows up before the first call.
  stateGauge?.set({ name: config.name }, 0);

  const fallback = (err: unknown): never => {
    if (err instanceof AppError) throw err;
    if (breaker.opened) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CIRCUIT_OPEN,
        `Circuit '${config.name}' is open`,
      );
    }
    if ((err as { code?: string } | undefined)?.code === 'ETIMEDOUT' || isOpossumTimeout(err)) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        `Upstream '${config.name}' timed out`,
      );
    }
    throw new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      `Upstream '${config.name}' unavailable`,
    );
  };

  return {
    raw: breaker,
    fire: (...args: TArgs) => breaker.fire(...args).catch(fallback) as Promise<TResult>,
  };
}

function isOpossumTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    /timed out/i.test((err as { message: string }).message)
  );
}

function lazyGauge(name: string, help: string, labelNames: string[]): Gauge<string> | undefined {
  try {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Gauge<string>;
    return new Gauge({ name, help, labelNames });
  } catch {
    return undefined;
  }
}

function lazyCounter(name: string, help: string, labelNames: string[]): Counter<string> | undefined {
  try {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Counter<string>;
    return new Counter({ name, help, labelNames });
  } catch {
    return undefined;
  }
}
