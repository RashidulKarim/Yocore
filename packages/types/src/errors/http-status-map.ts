import { ErrorCode } from './error-codes.js';

/**
 * ErrorCode → HTTP status code mapping.
 *
 * Single source of truth used by `apps/api/src/middleware/error-handler.ts`.
 * CI script `audit-error-codes.ts` ensures every ErrorCode has an entry here.
 */
export const httpStatusMap: Record<ErrorCode, number> = {
  // Auth
  [ErrorCode.AUTH_ACCOUNT_BANNED]: 403,
  [ErrorCode.AUTH_ACCOUNT_DELETED]: 410,
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 423,
  [ErrorCode.AUTH_ACCOUNT_SUSPENDED]: 403,
  [ErrorCode.AUTH_BOOTSTRAP_ALREADY_DONE]: 409,
  [ErrorCode.AUTH_BOOTSTRAP_SECRET_INVALID]: 401,
  [ErrorCode.AUTH_EMAIL_INVALID]: 422,
  [ErrorCode.AUTH_EMAIL_NOT_VERIFIED]: 403,
  [ErrorCode.AUTH_HOSTED_REDIRECT_NOT_ALLOWED]: 400,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_INVALID_TOKEN]: 401,
  [ErrorCode.AUTH_MFA_INVALID_CODE]: 401,
  [ErrorCode.AUTH_MFA_NOT_ENROLLED]: 403,
  [ErrorCode.AUTH_MFA_RECOVERY_NO_CODES]: 410,
  [ErrorCode.AUTH_MFA_REQUIRED]: 401,
  [ErrorCode.AUTH_PASSWORD_POLICY_VIOLATION]: 422,
  [ErrorCode.AUTH_PKCE_VERIFIER_MISMATCH]: 400,
  [ErrorCode.AUTH_REFRESH_REUSED]: 401,
  [ErrorCode.AUTH_TOKEN_EXPIRED]: 410,
  [ErrorCode.AUTH_TOKEN_REVOKED]: 401,
  [ErrorCode.AUTH_ONBOARDING_ALREADY_COMPLETE]: 409,
  // API key
  [ErrorCode.APIKEY_INVALID]: 401,
  [ErrorCode.APIKEY_MISSING]: 401,
  [ErrorCode.APIKEY_PRODUCT_INACTIVE]: 403,
  [ErrorCode.CORS_ORIGIN_NOT_ALLOWED]: 403,
  [ErrorCode.IP_NOT_ALLOWLISTED]: 403,
  // Validation
  [ErrorCode.BODY_TOO_LARGE]: 413,
  [ErrorCode.IDEMPOTENCY_KEY_CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS]: 425,
  [ErrorCode.IDEMPOTENCY_KEY_MISSING]: 400,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.VALIDATION_FAILED]: 422,
  // Resource
  [ErrorCode.BUNDLE_NOT_FOUND]: 404,
  [ErrorCode.INVITATION_ALREADY_USED]: 409,
  [ErrorCode.INVITATION_EXPIRED]: 410,
  [ErrorCode.INVITATION_NOT_FOUND]: 404,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.PLAN_NOT_FOUND]: 404,
  [ErrorCode.RESOURCE_CONFLICT]: 409,
  [ErrorCode.SUBSCRIPTION_NOT_FOUND]: 404,
  [ErrorCode.USER_NOT_FOUND]: 404,
  [ErrorCode.WORKSPACE_NOT_FOUND]: 404,
  // Permission
  [ErrorCode.OWNER_ONLY]: 403,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.SUPER_ADMIN_ONLY]: 403,
  [ErrorCode.WRONG_PRODUCT_SCOPE]: 403,
  // Quota
  [ErrorCode.EXPORT_COOLDOWN]: 429,
  [ErrorCode.QUOTA_EXCEEDED]: 402,
  [ErrorCode.SEAT_LIMIT_EXCEEDED]: 402,
  [ErrorCode.WORKSPACE_LIMIT_EXCEEDED]: 402,
  // Billing
  [ErrorCode.BILLING_BUNDLE_ELIGIBILITY_BLOCKED]: 409,
  [ErrorCode.BILLING_BUNDLE_VALIDATION_FAILED]: 422,
  [ErrorCode.BILLING_COUPON_EXHAUSTED]: 410,
  [ErrorCode.BILLING_COUPON_INVALID]: 422,
  [ErrorCode.BILLING_DOWNGRADE_BLOCKED]: 409,
  [ErrorCode.BILLING_GATEWAY_CIRCUIT_OPEN]: 503,
  [ErrorCode.BILLING_GATEWAY_CONFIG_MISSING]: 412,
  [ErrorCode.BILLING_GATEWAY_UNAVAILABLE]: 503,
  [ErrorCode.BILLING_NO_PAYMENT_METHOD]: 402,
  [ErrorCode.BILLING_PAYMENT_FAILED]: 402,
  [ErrorCode.BILLING_PLAN_IMMUTABLE]: 409,
  [ErrorCode.BILLING_PLAN_NOT_PUBLISHED]: 409,
  [ErrorCode.BILLING_SUBSCRIPTION_NOT_ACTIVE]: 409,
  [ErrorCode.BILLING_TRIAL_INELIGIBLE]: 409,
  [ErrorCode.BILLING_USAGE_HARD_CAP_EXCEEDED]: 402,
  // Webhooks
  [ErrorCode.WEBHOOK_EVENT_DUPLICATE]: 200, // intentional: dedup short-circuits to 200
  [ErrorCode.WEBHOOK_PAYLOAD_INVALID]: 422,
  [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: 401,
  [ErrorCode.WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE]: 401,
  // Rate
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  // Server
  [ErrorCode.CACHE_UNAVAILABLE]: 503,
  [ErrorCode.DB_UNAVAILABLE]: 503,
  [ErrorCode.EMAIL_SEND_FAILED]: 502,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.S3_UNAVAILABLE]: 503,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  // GDPR
  [ErrorCode.GDPR_DELETION_BLOCKED]: 409,
  [ErrorCode.GDPR_DELETION_PENDING]: 409,
  [ErrorCode.TOS_NOT_ACCEPTED]: 451,
};

export function httpStatusFor(code: ErrorCode): number {
  return httpStatusMap[code] ?? 500;
}
