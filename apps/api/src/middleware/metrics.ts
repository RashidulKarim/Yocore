/**
 * Express middleware that records HTTP request duration and in-flight gauge.
 * Mounted before the router.
 */
import type { RequestHandler } from 'express';
import { httpInflight, httpRequestDuration } from '../lib/metrics.js';

export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    httpInflight.inc();
    res.on('finish', () => {
      httpInflight.dec();
      const route = (req.route as { path?: string } | undefined)?.path ?? req.baseUrl ?? req.path;
      const dur = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequestDuration
        .labels(req.method, route || 'unknown', String(res.statusCode))
        .observe(dur);
    });
    next();
  };
}
