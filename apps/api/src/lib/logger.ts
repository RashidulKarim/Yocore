import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';
import { getCorrelationId, getRequestId } from './correlation-id.js';

/**
 * Pino redaction list — every field that may carry a secret in dev/test logs.
 * Adding a new sensitive field? Add it here AND update CI's audit-log-redaction.ts.
 */
const REDACT_PATHS = [
  // Headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-bootstrap-secret"]',
  'req.headers["x-webhook-signature"]',
  'req.headers["stripe-signature"]',
  'req.headers["sslcommerz-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["x-bootstrap-secret"]',
  // Body / payload secrets
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.refreshTokenHash',
  '*.apiKey',
  '*.apiKeySecret',
  '*.secret',
  '*.clientSecret',
  '*.privateKey',
  '*.signingKey',
  '*.encryptionKey',
  '*.kmsKey',
  '*.bootstrapSecret',
  '*.mfaSecret',
  '*.mfaCode',
  '*.totp',
  '*.otp',
  '*.recoveryCode',
  '*.webhookSecret',
  '*.stripeApiKey',
  '*.stripeSecret',
  '*.dek',
  '*.encryptedDek',
  // Nested duplicates
  'body.password',
  'body.newPassword',
  'body.currentPassword',
  'body.token',
  'body.refreshToken',
  'body.mfaCode',
  'body.otp',
  'user.password',
  'user.passwordHash',
  'user.mfaSecret',
  'user.recoveryCodes',
  'data.password',
  'data.token',
];

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: {
    instance: env.INSTANCE_ID,
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (b) => ({ pid: b.pid, hostname: b.hostname, instance: b.instance, env: b.env }),
    log: (obj) => {
      const correlationId = getCorrelationId();
      const requestId = getRequestId();
      return {
        ...obj,
        ...(correlationId ? { correlationId } : {}),
        ...(requestId ? { requestId } : {}),
      };
    },
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
        },
      }
    : {}),
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export { REDACT_PATHS as __redactPathsForTesting };
