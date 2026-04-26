import { z } from 'zod';
import { emailSchema, passwordSchema } from './common.js';

/**
 * Auth schemas used by /v1/auth/* and /v1/admin/* endpoints.
 *
 * These are the single source of truth for request shapes. Handlers parse
 * with `schema.parse(req.body)` and the SDK consumes the inferred types.
 */

// ─── Bootstrap ────────────────────────────────────────────────────────────────

export const bootstrapRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const bootstrapResponseSchema = z.object({
  userId: z.string(),
  email: emailSchema,
  mfaEnrolmentRequired: z.literal(true),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

// ─── End-user Signup (Flow F) ────────────────────────────────────────────────

/**
 * Per Flow F + FIX-AUTH-TIMING:
 *   - The endpoint is public (no API key required) — any product on the platform
 *     accepts new signups via its public slug.
 *   - The handler always runs the same Argon2 work and returns an identical
 *     response shape regardless of whether the email is already taken, so an
 *     attacker cannot enumerate accounts via timing or status diffs.
 */
export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  productSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/, 'invalid product slug'),
  name: z
    .object({
      first: z.string().trim().min(1).max(80).optional(),
      last: z.string().trim().min(1).max(80).optional(),
    })
    .optional(),
  marketingOptIn: z.boolean().optional().default(false),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupResponseSchema = z.object({
  /** Always the same value to prevent enumeration. */
  status: z.literal('verification_sent'),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

// ─── Sign-in ──────────────────────────────────────────────────────────────────

export const signinRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  /** When provided, the request targets a specific product's user pool. */
  productSlug: z.string().min(1).max(64).optional(),
  /** TOTP code or recovery code — submitted on the second leg after MFA challenge. */
  mfaCode: z
    .string()
    .min(6)
    .max(40)
    .regex(/^[A-Z0-9-]+$/i)
    .optional(),
  /** Opaque challenge id from the first leg — required when mfaCode is supplied. */
  mfaChallengeId: z.string().min(1).max(128).optional(),
  rememberMe: z.boolean().optional().default(false),
});
export type SigninRequest = z.infer<typeof signinRequestSchema>;

export const tokensResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Seconds until accessToken expires. */
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
});
export type TokensResponse = z.infer<typeof tokensResponseSchema>;

export const signinResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('mfa_required'),
    mfaChallengeId: z.string(),
    /** Which factor types are allowed for the next leg. */
    factors: z.array(z.enum(['totp', 'recovery_code'])),
  }),
  z.object({
    status: z.literal('signed_in'),
    userId: z.string(),
    role: z.enum(['SUPER_ADMIN', 'END_USER']),
    productId: z.string().nullable(),
    tokens: tokensResponseSchema,
  }),
]);
export type SigninResponse = z.infer<typeof signinResponseSchema>;

// ─── Refresh ─────────────────────────────────────────────────────────────────

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = tokensResponseSchema;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

// ─── Logout ──────────────────────────────────────────────────────────────────

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(20).max(512).optional(),
  scope: z.enum(['session', 'all']).optional().default('session'),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

// ─── MFA enrol / verify / recovery (TOTP) ────────────────────────────────────

export const mfaEnrolStartResponseSchema = z.object({
  /** Opaque enrolment id; pass back in `mfaEnrolVerify`. */
  enrolmentId: z.string(),
  /** otpauth://totp/... URI for QR rendering. */
  otpauthUri: z.string().url(),
  /** Plain base32 secret (so the user can copy/paste). */
  secret: z.string().min(16),
});
export type MfaEnrolStartResponse = z.infer<typeof mfaEnrolStartResponseSchema>;

export const mfaEnrolVerifyRequestSchema = z.object({
  enrolmentId: z.string().min(1),
  code: z
    .string()
    .min(6)
    .max(8)
    .regex(/^\d+$/, 'must be digits'),
});
export type MfaEnrolVerifyRequest = z.infer<typeof mfaEnrolVerifyRequestSchema>;

export const mfaEnrolVerifyResponseSchema = z.object({
  enrolled: z.literal(true),
  /** Plain recovery codes — shown ONCE; we only store the hash. */
  recoveryCodes: z.array(z.string()).length(10),
});
export type MfaEnrolVerifyResponse = z.infer<typeof mfaEnrolVerifyResponseSchema>;

export const mfaStatusResponseSchema = z.object({
  enrolled: z.boolean(),
  type: z.enum(['totp']).nullable(),
  enrolledAt: z.string().datetime().nullable(),
  recoveryCodesRemaining: z.number().int().nonnegative(),
});
export type MfaStatusResponse = z.infer<typeof mfaStatusResponseSchema>;

export const mfaRegenerateRecoveryCodesResponseSchema = z.object({
  recoveryCodes: z.array(z.string()).length(10),
});
export type MfaRegenerateRecoveryCodesResponse = z.infer<
  typeof mfaRegenerateRecoveryCodesResponseSchema
>;

// ─── Email verification (Flow F10/F11) ────────────────────────────────────────

/**
 * GET /v1/auth/verify-email — token comes in as a query param. Idempotent:
 * a re-click after success returns `alreadyVerified:true` plus a fresh session
 * (Flow F11 auto-login). Expired tokens → 410 AUTH_TOKEN_EXPIRED.
 */
export const verifyEmailRequestSchema = z.object({
  token: z.string().min(20).max(256),
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const verifyEmailResponseSchema = z.object({
  status: z.literal('verified'),
  alreadyVerified: z.boolean(),
  userId: z.string(),
  productId: z.string(),
  onboarded: z.boolean(),
  tokens: tokensResponseSchema,
});
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;

// ─── Onboarding finalisation (Flow F12) ───────────────────────────────────────

/**
 * POST /v1/auth/finalize-onboarding — runs once per (user × product). Creates
 * the user's first workspace as OWNER and flips `productUsers.onboarded=true`.
 * Allowed for END_USERs whose email is verified but `onboarded=false`.
 */
export const finalizeOnboardingRequestSchema = z.object({
  workspaceName: z.string().trim().min(2).max(80),
  /** Optional URL-safe slug; auto-derived from workspaceName when omitted. */
  workspaceSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, 'invalid workspace slug')
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(20).optional(),
  dateFormat: z.string().min(1).max(32).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
});
export type FinalizeOnboardingRequest = z.infer<typeof finalizeOnboardingRequestSchema>;

export const finalizeOnboardingResponseSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  productUser: z.object({
    onboarded: z.literal(true),
  }),
});
export type FinalizeOnboardingResponse = z.infer<typeof finalizeOnboardingResponseSchema>;

// ─── Cross-product join confirm (Flow I) ──────────────────────────────────────

/**
 * GET /v1/auth/confirm-join — consumes a `product_join_confirm` token. Used
 * when an existing global user signs up for a different product. The signup
 * route detects the duplicate, queues a join-confirmation email, and this
 * endpoint creates the new productUser row + auto-logs in.
 */
export const confirmJoinRequestSchema = z.object({
  token: z.string().min(20).max(256),
});
export type ConfirmJoinRequest = z.infer<typeof confirmJoinRequestSchema>;

export const confirmJoinResponseSchema = z.object({
  status: z.literal('joined'),
  alreadyJoined: z.boolean(),
  userId: z.string(),
  productId: z.string(),
  onboarded: z.boolean(),
  tokens: tokensResponseSchema,
});
export type ConfirmJoinResponse = z.infer<typeof confirmJoinResponseSchema>;

// ─── Forgot / reset password (Flow O) ─────────────────────────────────────────

/**
 * POST /v1/auth/forgot-password — public, constant-time. Always returns 202.
 * When `productSlug` is provided the reset is scoped to that product's
 * `productUsers` row; otherwise it targets the global SUPER_ADMIN credential.
 */
export const forgotPasswordRequestSchema = z.object({
  email: emailSchema,
  productSlug: z.string().min(1).max(64).optional(),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const forgotPasswordResponseSchema = z.object({
  status: z.literal('reset_email_sent'),
});
export type ForgotPasswordResponse = z.infer<typeof forgotPasswordResponseSchema>;

/**
 * POST /v1/auth/reset-password — consumes a `password_reset` token. Sets the
 * new password, revokes ALL existing sessions for the user (FIX-AUTH-RESET),
 * and returns no tokens — caller must sign in again.
 */
export const resetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(256),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const resetPasswordResponseSchema = z.object({
  status: z.literal('password_reset'),
});
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;

// ─── Email change (Flow P) ────────────────────────────────────────────────────

/**
 * POST /v1/auth/email/change-request — authenticated. Issues a token to the
 * NEW address. Confirming it updates the email and revokes ALL sessions.
 */
export const emailChangeRequestSchema = z.object({
  newEmail: emailSchema,
  password: z.string().min(1).max(256),
});
export type EmailChangeRequest = z.infer<typeof emailChangeRequestSchema>;

export const emailChangeRequestResponseSchema = z.object({
  status: z.literal('email_change_requested'),
});
export type EmailChangeRequestResponse = z.infer<typeof emailChangeRequestResponseSchema>;

export const emailChangeConfirmRequestSchema = z.object({
  token: z.string().min(20).max(256),
});
export type EmailChangeConfirmRequest = z.infer<typeof emailChangeConfirmRequestSchema>;

export const emailChangeConfirmResponseSchema = z.object({
  status: z.literal('email_changed'),
  newEmail: emailSchema,
});
export type EmailChangeConfirmResponse = z.infer<typeof emailChangeConfirmResponseSchema>;

// ─── Email preferences + unsubscribe (Flow AI) ────────────────────────────────

export const emailPreferencesSchema = z.object({
  marketing: z.boolean(),
  productUpdates: z.boolean(),
  billing: z.boolean(),
  security: z.boolean(),
});
export type EmailPreferences = z.infer<typeof emailPreferencesSchema>;

export const emailPreferencesPatchSchema = emailPreferencesSchema.partial();
export type EmailPreferencesPatch = z.infer<typeof emailPreferencesPatchSchema>;

/**
 * POST /v1/email/unsubscribe — RFC 8058 List-Unsubscribe-Post. Token is a
 * signed `email_unsubscribe` payload (HMAC-SHA256). Always returns 200.
 */
export const unsubscribeRequestSchema = z.object({
  token: z.string().min(10).max(512),
});
export type UnsubscribeRequest = z.infer<typeof unsubscribeRequestSchema>;

export const unsubscribeResponseSchema = z.object({
  status: z.literal('unsubscribed'),
  category: z.enum(['marketing', 'productUpdates', 'billing', 'security']),
});
export type UnsubscribeResponse = z.infer<typeof unsubscribeResponseSchema>;

// ─── Hosted Auth (Flow U — minimal PKCE) ──────────────────────────────────────

/**
 * GET /v1/auth/authorize — first leg. The hosted-UI redirects the user back
 * to `redirect_uri?code=<auth_code>` after sign-in. This server endpoint is
 * exposed for SDK programmatic flows; an `id_token`/JS UI lives in auth-web.
 *
 * NOTE: The full Hosted Auth UI is owned by `apps/auth-web`. This schema
 * covers the JSON shape the API surfaces, not the redirect HTTP semantics.
 */
export const authorizeRequestSchema = z.object({
  productSlug: z.string().min(1).max(64),
  redirectUri: z.string().url(),
  state: z.string().min(1).max(256),
  codeChallenge: z.string().min(43).max(128),
  codeChallengeMethod: z.literal('S256'),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

export const exchangeRequestSchema = z.object({
  code: z.string().min(20).max(256),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().url(),
});
export type ExchangeRequest = z.infer<typeof exchangeRequestSchema>;

export const exchangeResponseSchema = z.object({
  status: z.literal('exchanged'),
  userId: z.string(),
  productId: z.string(),
  tokens: tokensResponseSchema,
});
export type ExchangeResponse = z.infer<typeof exchangeResponseSchema>;
