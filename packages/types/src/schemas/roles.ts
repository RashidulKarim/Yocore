/**
 * V1.2 — Roles & Permissions schemas.
 *
 * Backs `/v1/admin/products/:id/roles` (custom role CRUD) and
 * `/v1/admin/products/:id/admins` (PRODUCT_ADMIN grant/revoke).
 *
 * SUPER_ADMIN-only endpoints; the handler layer enforces auth.
 */
import { z } from 'zod';
import { idSchema } from './common.js';

// ── Role slug — uppercase letters/digits/underscore (e.g. EDITOR, EDITOR_2) ──
export const customRoleSlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Slug must be uppercase alphanumeric + underscore');

const permissionStringSchema = z.string().min(1).max(80);

export const createRoleRequestSchema = z
  .object({
    slug: customRoleSlugSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    permissions: z.array(permissionStringSchema).max(200).default([]),
    inheritsFrom: idSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    permissions: z.array(permissionStringSchema).max(200).optional(),
    inheritsFrom: idSchema.nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export const roleSummarySchema = z.object({
  id: idSchema,
  productId: idSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isPlatform: z.boolean(),
  isDefault: z.boolean(),
  permissions: z.array(z.string()),
  inheritsFrom: idSchema.nullable(),
  memberCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const listRolesResponseSchema = z.object({
  roles: z.array(roleSummarySchema),
});
export type ListRolesResponse = z.infer<typeof listRolesResponseSchema>;

// ── Product Admins (System Design §5.15 — GAP-03) ────────────────────
export const grantProductAdminRequestSchema = z
  .object({
    userId: idSchema,
  })
  .strict();
export type GrantProductAdminRequest = z.infer<typeof grantProductAdminRequestSchema>;

export const productAdminSummarySchema = z.object({
  userId: idSchema,
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  status: z.string(),
  joinedAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
});
export type ProductAdminSummary = z.infer<typeof productAdminSummarySchema>;

export const listProductAdminsResponseSchema = z.object({
  admins: z.array(productAdminSummarySchema),
});
export type ListProductAdminsResponse = z.infer<typeof listProductAdminsResponseSchema>;
