import { z } from 'zod';

/**
 * Shared primitive schemas reused by every other schema module.
 * Keep this file dependency-light — no zod-to-openapi imports here.
 */

/** ULID/yc-id shaped string ('usr_01H...'). 26+ chars after the prefix is fine. */
export const idSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[a-z0-9]+_[A-Za-z0-9]+$/, 'invalid id format');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('invalid email');

/**
 * Strong password policy:
 *   - 12+ chars
 *   - at least one upper, lower, digit, and symbol
 *   - max 256 chars (defensive against DoS)
 */
export const passwordSchema = z
  .string()
  .min(12, 'password must be ≥12 chars')
  .max(256, 'password too long')
  .refine((p) => /[a-z]/.test(p), 'must contain a lowercase letter')
  .refine((p) => /[A-Z]/.test(p), 'must contain an uppercase letter')
  .refine((p) => /\d/.test(p), 'must contain a digit')
  .refine((p) => /[^A-Za-z0-9]/.test(p), 'must contain a symbol');

export const correlationIdSchema = z.string().min(1).max(64);

/** Common error response shape (returned by the central error handler). */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  correlationId: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
