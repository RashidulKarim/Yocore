/**
 * Cross-cutting platform constants. Kept centralized so SDK + UI + API agree.
 */

export const Roles = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  END_USER: 'END_USER',
} as const;
export type Role = (typeof Roles)[keyof typeof Roles];

export const SessionRevocationReasons = {
  USER_LOGOUT: 'user_logout',
  ADMIN: 'admin',
  REFRESH_REUSE: 'refresh_reuse',
  PASSWORD_CHANGE: 'password_change',
  MFA_RESET: 'mfa_reset',
} as const;
export type SessionRevocationReason =
  (typeof SessionRevocationReasons)[keyof typeof SessionRevocationReasons];

/**
 * Caps used by AuthService:
 *   - max consecutive failed sign-ins before lockout
 *   - lockout duration after that threshold (minutes)
 */
export const AuthLimits = {
  MAX_FAILED_LOGIN_ATTEMPTS: 5,
  LOCKOUT_MINUTES: 15,
  /** TOTP challenge id TTL (seconds) — first leg → second leg. */
  MFA_CHALLENGE_TTL_SECONDS: 5 * 60,
  /** TOTP enrolment session TTL (seconds). */
  MFA_ENROLMENT_TTL_SECONDS: 10 * 60,
  /** Plain recovery codes generated per enrolment / regeneration. */
  RECOVERY_CODES_COUNT: 10,
} as const;

// ── Subscription ────────────────────────────────────────────────────────
export const SubscriptionStatuses = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELED',
  INCOMPLETE: 'INCOMPLETE',
  PAUSED: 'PAUSED',
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatuses)[keyof typeof SubscriptionStatuses];

export const BillingIntervals = {
  MONTH: 'month',
  YEAR: 'year',
} as const;
export type BillingInterval = (typeof BillingIntervals)[keyof typeof BillingIntervals];

export const BillingScopes = {
  USER: 'user',
  WORKSPACE: 'workspace',
} as const;
export type BillingScope = (typeof BillingScopes)[keyof typeof BillingScopes];

export const PaymentGatewayIds = {
  STRIPE: 'stripe',
  SSLCOMMERZ: 'sslcommerz',
  PAYPAL: 'paypal',
  PADDLE: 'paddle',
} as const;
export type PaymentGatewayId =
  (typeof PaymentGatewayIds)[keyof typeof PaymentGatewayIds];

// ── Limits ─────────────────────────────────────────────────────────────
export const PlatformLimits = {
  WORKSPACE_MAX_MEMBERS_DEFAULT: 100,
  VOLUNTARY_DELETION_GRACE_DAYS: 30,
  FAILED_PAYMENT_GRACE_DAYS: 7,
  TRIAL_MAX_DAYS: 30,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS: 6,
  JWT_VERIFY_GRACE_MINUTES: 30,
  WEBHOOK_SIGNATURE_TOLERANCE_MINUTES: 5,
  IDEMPOTENCY_CACHE_TTL_HOURS: 24,
  IP_ALLOWLIST_MAX_ENTRIES: 50,
  DEFAULT_API_KEY_RATE_LIMIT_PER_MINUTE: 1000,
} as const;
