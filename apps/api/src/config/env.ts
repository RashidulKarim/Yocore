import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  INSTANCE_ID: z.string().min(1).default('local-1'),

  // Database
  MONGODB_URI: z.string().min(1),
  MONGODB_REPLICA_SET: z.string().optional(),

  // Redis
  REDIS_URL: z.string().min(1),

  // Encryption
  YOCORE_KMS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'YOCORE_KMS_KEY must be 64 hex chars (32 bytes)'),

  // JWT
  JWT_ISSUER: z.string().default('yocore'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  JWT_REFRESH_TTL_NO_REMEMBER_SECONDS: z.coerce.number().int().positive().default(604_800),

  // Bootstrap
  BOOTSTRAP_SECRET: z.string().min(32),

  // Super Admin IP allowlist (comma-separated CIDRs)
  SUPER_ADMIN_IP_ALLOWLIST: z.string().default(''),
  SUPER_ADMIN_IP_ALLOWLIST_BYPASS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Email
  EMAIL_PROVIDER: z.enum(['resend', 'ses']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  SES_REGION: z.string().default('us-east-1'),
  EMAIL_FROM_DEFAULT: z.string().email().default('noreply@notifications.yocore.io'),

  // AWS
  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET_WEBHOOKS: z.string().default('yocore-webhooks'),
  S3_BUCKET_AUDITLOGS: z.string().default('yocore-auditlogs'),
  S3_BUCKET_EXPORTS: z.string().default('yocore-exports'),
  S3_BUCKET_AVATARS: z.string().default('yocore-avatars'),

  // Observability
  SENTRY_DSN: z.string().optional(),
  GRAFANA_OTEL_ENDPOINT: z.string().optional(),
  MAXMIND_LICENSE_KEY: z.string().optional(),

  // Rate limiting
  DEFAULT_API_KEY_RATE_LIMIT: z.coerce.number().int().positive().default(1000),

  // Argon2
  ARGON2_POOL_SIZE: z.coerce.number().int().positive().max(32).default(4),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
