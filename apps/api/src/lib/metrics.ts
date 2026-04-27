/**
 * Prometheus metrics registry — V1.1-F.
 *
 * Re-exports the global `prom-client` `register` plus high-level YoCore metric
 * primitives. Modules that emit metrics (HTTP middleware, webhook worker,
 * cron runner, sign-in handler, etc.) should import the helpers from here so
 * we have a single canonical place where labels and names are defined.
 *
 * Naming convention: `yocore_<area>_<unit>` (e.g. `yocore_signin_duration_seconds`).
 */
import { register, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

let started = false;
export function startDefaultMetrics(): void {
  if (started) return;
  started = true;
  collectDefaultMetrics({ prefix: 'yocore_', register });
}

// ── Sign-in latency ─────────────────────────────────────────────────
export const signinDuration = lazyHistogram(
  'yocore_signin_duration_seconds',
  'Sign-in handler duration (seconds), labelled by outcome.',
  ['outcome'],
  [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
);

// ── Webhook delivery ────────────────────────────────────────────────
export const webhookDeliveryTotal = lazyCounter(
  'yocore_webhook_delivery_total',
  'Total outbound webhook deliveries.',
  ['status'], // delivered | retried | dead | skipped
);

export const webhookDeliveryDuration = lazyHistogram(
  'yocore_webhook_delivery_duration_seconds',
  'Outbound webhook delivery duration (seconds).',
  ['outcome'],
  [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
);

// ── Cron jobs ───────────────────────────────────────────────────────
export const cronRunTotal = lazyCounter(
  'yocore_cron_run_total',
  'Total cron job runs.',
  ['job', 'outcome'], // outcome: ran | skipped | failed
);

export const cronFailureTotal = lazyCounter(
  'yocore_cron_failure_total',
  'Total cron job failures.',
  ['job'],
);

export const cronLastRunTimestamp = lazyGauge(
  'yocore_cron_last_run_timestamp_seconds',
  'Unix timestamp of the most recent successful run for each cron job.',
  ['job'],
);

// ── HTTP layer ──────────────────────────────────────────────────────
export const httpRequestDuration = lazyHistogram(
  'yocore_http_request_duration_seconds',
  'HTTP request duration (seconds), labelled by route + method + status.',
  ['method', 'route', 'status'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
);

export const httpInflight = lazyGauge(
  'yocore_http_in_flight_requests',
  'Number of HTTP requests currently being processed.',
  [],
);

// ── Re-exports ──────────────────────────────────────────────────────
export { register };

// ── Internals ───────────────────────────────────────────────────────
function lazyHistogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[],
): Histogram<string> {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({ name, help, labelNames, buckets });
}

function lazyCounter(name: string, help: string, labelNames: string[]): Counter<string> {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Counter<string>;
  return new Counter({ name, help, labelNames });
}

function lazyGauge(name: string, help: string, labelNames: string[]): Gauge<string> {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Gauge<string>;
  return new Gauge({ name, help, labelNames });
}
