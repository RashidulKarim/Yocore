/**
 * OpenTelemetry SDK bootstrap — V1.1-F.
 *
 * Initialises tracing if `GRAFANA_OTEL_ENDPOINT` (OTLP/HTTP) is set. Auto
 * instruments Express, Mongoose, Redis (ioredis), Pino, fetch, and AWS-SDK.
 *
 * Call `startOtel()` ONCE at process boot, BEFORE any other instrumented
 * library is imported (i.e. before Express). `index.ts` calls this at the
 * very top of `bootstrap()`.
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

let started = false;

export async function startOtel(): Promise<void> {
  if (started) return;
  started = true;

  if (!env.GRAFANA_OTEL_ENDPOINT) {
    logger.info({ event: 'otel.disabled' }, 'OTel disabled (no GRAFANA_OTEL_ENDPOINT)');
    return;
  }

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import(
      '@opentelemetry/exporter-trace-otlp-http'
    );
    const { getNodeAutoInstrumentations } = await import(
      '@opentelemetry/auto-instrumentations-node'
    );
    const { Resource } = await import('@opentelemetry/resources');
    const semconv = await import('@opentelemetry/semantic-conventions');

    const sdk = new NodeSDK({
      resource: new Resource({
        [semconv.ATTR_SERVICE_NAME]: 'yocore-api',
        [semconv.ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.0.0',
        'deployment.environment': env.NODE_ENV,
        'service.instance.id': env.INSTANCE_ID,
      }),
      traceExporter: new OTLPTraceExporter({
        url: env.GRAFANA_OTEL_ENDPOINT,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Skip noisy filesystem instrumentation in production.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    logger.info(
      { event: 'otel.started', endpoint: env.GRAFANA_OTEL_ENDPOINT },
      'OpenTelemetry SDK started',
    );

    process.on('SIGTERM', () => {
      sdk.shutdown().catch((err) => logger.error({ err }, 'OTel shutdown error'));
    });
  } catch (err) {
    logger.error({ event: 'otel.start.failed', err }, 'OTel SDK failed to start');
  }
}
