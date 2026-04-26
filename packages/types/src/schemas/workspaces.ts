import { z } from 'zod';
import { emailSchema } from './common.js';

/**
 * Schemas for Phase 3.2 — Workspaces, Members, Roles, Permissions.
 *
 * Endpoints (`apps/api/src/router.ts`):
 *   - POST   /v1/workspaces                        (create — Flow L)
 *   - GET    /v1/workspaces                        (list user's memberships)
 *   - GET    /v1/workspaces/:id                    (detail)
 *   - PATCH  /v1/workspaces/:id                    (update name/timezone/settings)
 *   - DELETE /v1/workspaces/:id                    (voluntary delete — Flow AA)
 *   - POST   /v1/workspaces/:id/restore            (within 30d window)
 *   - POST   /v1/workspaces/:id/transfer-ownership (Flow Z)
 *   - POST   /v1/auth/switch-workspace             (Flow L3)
 *   - GET    /v1/workspaces/:id/members
 *   - PATCH  /v1/workspaces/:id/members/:userId    (change role)
 *   - DELETE /v1/workspaces/:id/members/:userId    (remove member)
 *   - POST   /v1/workspaces/:id/invitations        (Flow M)
 *   - GET    /v1/workspaces/:id/invitations
 *   - DELETE /v1/workspaces/:id/invitations/:invId (revoke)
 *   - GET    /v1/invitations/preview?token=...
 *   - POST   /v1/invitations/accept                (Path A — existing user)
 *   - POST   /v1/invitations/accept-new            (Path B — new user)
 *   - POST   /v1/permissions/check
 *   - GET    /v1/permissions/catalog
 */

// ─── Common ──────────────────────────────────────────────────────────────────

const workspaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, 'invalid workspace slug');

const workspaceNameSchema = z.string().trim().min(2).max(80);

/**
 * Role slugs. Platform roles (OWNER/ADMIN/MEMBER/VIEWER) ship with every
 * product; product owners may add custom roles later (slugs in [A-Z0-9_]).
 */
const roleSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'role slug must be UPPER_SNAKE');

// ─── Workspace CRUD ──────────────────────────────────────────────────────────

export const createWorkspaceRequestSchema = z.object({
  name: workspaceNameSchema,
  slug: workspaceSlugSchema.optional(),
  timezone: z.string().min(1).max(64).optional(),
  settings: z.record(z.unknown()).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const workspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']),
  suspended: z.boolean(),
  ownerUserId: z.string(),
  timezone: z.string(),
  voluntaryDeletionFinalizesAt: z.string().datetime().nullable().optional(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const createWorkspaceResponseSchema = z.object({
  workspace: workspaceSummarySchema,
});
export type CreateWorkspaceResponse = z.infer<typeof createWorkspaceResponseSchema>;

export const listWorkspacesResponseSchema = z.object({
  workspaces: z.array(
    workspaceSummarySchema.extend({
      role: roleSlugSchema,
    }),
  ),
});
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponseSchema>;

export const getWorkspaceResponseSchema = z.object({
  workspace: workspaceSummarySchema.extend({
    settings: z.record(z.unknown()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
});

export const updateWorkspaceRequestSchema = z
  .object({
    name: workspaceNameSchema.optional(),
    timezone: z.string().min(1).max(64).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const deleteWorkspaceRequestSchema = z.object({
  password: z.string().min(1).max(256),
  confirmName: z.string().min(1).max(80),
});
export type DeleteWorkspaceRequest = z.infer<typeof deleteWorkspaceRequestSchema>;

export const transferOwnershipRequestSchema = z.object({
  newOwnerUserId: z.string().min(4).max(64),
  password: z.string().min(1).max(256),
});
export type TransferOwnershipRequest = z.infer<typeof transferOwnershipRequestSchema>;

// ─── Switch workspace (re-issues access token) ───────────────────────────────

export const switchWorkspaceRequestSchema = z.object({
  workspaceId: z.string().min(4).max(64),
});
export type SwitchWorkspaceRequest = z.infer<typeof switchWorkspaceRequestSchema>;

export const switchWorkspaceResponseSchema = z.object({
  status: z.literal('switched'),
  workspaceId: z.string(),
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
});
export type SwitchWorkspaceResponse = z.infer<typeof switchWorkspaceResponseSchema>;

// ─── Members ─────────────────────────────────────────────────────────────────

export const memberSummarySchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  roleSlug: roleSlugSchema,
  status: z.enum(['ACTIVE', 'INVITED', 'REMOVED']),
  joinedAt: z.string().datetime(),
});
export type MemberSummary = z.infer<typeof memberSummarySchema>;

export const listMembersResponseSchema = z.object({
  members: z.array(memberSummarySchema),
});
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

export const changeMemberRoleRequestSchema = z.object({
  roleSlug: roleSlugSchema,
});
export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;

// ─── Invitations ─────────────────────────────────────────────────────────────

export const createInvitationRequestSchema = z.object({
  email: emailSchema,
  roleSlug: roleSlugSchema,
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  roleSlug: roleSlugSchema,
  status: z.enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']),
  isExistingUser: z.boolean(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;

export const createInvitationResponseSchema = z.object({
  invitation: invitationSummarySchema,
});

export const listInvitationsResponseSchema = z.object({
  invitations: z.array(invitationSummarySchema),
});

export const previewInvitationResponseSchema = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  productId: z.string(),
  email: z.string(),
  roleSlug: roleSlugSchema,
  isExistingUser: z.boolean(),
  expiresAt: z.string().datetime(),
});

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(20).max(256),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const acceptInvitationNewRequestSchema = z.object({
  token: z.string().min(20).max(256),
  password: z.string().min(12).max(256),
  name: z
    .object({
      first: z.string().trim().min(1).max(80).optional(),
      last: z.string().trim().min(1).max(80).optional(),
    })
    .optional(),
});
export type AcceptInvitationNewRequest = z.infer<typeof acceptInvitationNewRequestSchema>;

// ─── Permissions ─────────────────────────────────────────────────────────────

export const permissionsCheckRequestSchema = z.object({
  userId: z.string().min(4).max(64),
  workspaceId: z.string().min(4).max(64),
  permissions: z.array(z.string().min(1).max(80)).min(1).max(64),
});
export type PermissionsCheckRequest = z.infer<typeof permissionsCheckRequestSchema>;

export const permissionsCheckResponseSchema = z.object({
  userId: z.string(),
  workspaceId: z.string(),
  roleSlug: roleSlugSchema.nullable(),
  results: z.record(z.string(), z.boolean()),
  cached: z.boolean(),
});
export type PermissionsCheckResponse = z.infer<typeof permissionsCheckResponseSchema>;

export const permissionsCatalogResponseSchema = z.object({
  permissions: z.array(z.string()),
  roles: z.array(
    z.object({
      slug: roleSlugSchema,
      name: z.string(),
      isPlatform: z.boolean(),
      permissions: z.array(z.string()),
    }),
  ),
});
export type PermissionsCatalogResponse = z.infer<typeof permissionsCatalogResponseSchema>;
