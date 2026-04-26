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
