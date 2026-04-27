/**
 * User-facing schemas — self-service endpoints (V1.0-E):
 *   - GET/PATCH /v1/users/me        — profile read/update
 *   - GET       /v1/sessions        — active sessions list response
 *   - DELETE    /v1/users/me        — request self-deletion (re-uses admin schema)
 */
import { z } from 'zod';

// ── Profile ─────────────────────────────────────────────────────────────
export const updateUserProfileRequestSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().min(4).max(40).optional(),
    avatarUrl: z.string().url().optional(),
    locale: z.string().trim().min(2).max(10).optional(),
    timezone: z.string().trim().min(2).max(60).optional(),
  })
  .strict();
export type UpdateUserProfileRequest = z.infer<typeof updateUserProfileRequestSchema>;

export const userProfileResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  productId: z.string().nullable(),
  role: z.enum(['SUPER_ADMIN', 'END_USER']),
  status: z.string(),
  emailVerified: z.boolean(),
  tosVersion: z.string().nullable(),
  privacyPolicyVersion: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;

// ── Sessions list ──────────────────────────────────────────────────────
export const sessionListItemSchema = z.object({
  id: z.string(),
  productId: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

// ── ToS acceptance gate (V1.0-B / B-05) ────────────────────────────────
/** Embedded in signup + finalize-onboarding requests. */
export const tosAcceptanceSchema = z.object({
  acceptedTosVersion: z.string().min(1).max(20),
  acceptedPrivacyVersion: z.string().min(1).max(20),
});
export type TosAcceptance = z.infer<typeof tosAcceptanceSchema>;

// ── Current ToS lookup (public) ────────────────────────────────────────
export const currentTosResponseSchema = z.object({
  termsOfService: z
    .object({
      version: z.string(),
      effectiveAt: z.string().datetime(),
      contentUrl: z.string().url(),
      contentHash: z.string(),
    })
    .nullable(),
  privacyPolicy: z
    .object({
      version: z.string(),
      effectiveAt: z.string().datetime(),
      contentUrl: z.string().url(),
      contentHash: z.string(),
    })
    .nullable(),
});
export type CurrentTosResponse = z.infer<typeof currentTosResponseSchema>;
