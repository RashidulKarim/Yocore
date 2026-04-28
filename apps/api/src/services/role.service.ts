/**
 * V1.2-A — Custom Role CRUD service.
 *
 * Backs `/v1/admin/products/:id/roles` (Super-Admin-only). Operates on the
 * `roles` collection via `role.repo.ts`; bumps the permission cache when a
 * role is mutated so subsequent permission checks see fresh data.
 *
 * Platform roles (OWNER/ADMIN/MEMBER/VIEWER) are immutable — any mutation
 * attempt → 403 PERMISSION_DENIED.
 *
 * Deletion is blocked when active members still carry the role
 * → 409 RESOURCE_CONFLICT (caller must reassign first).
 */
import type { Redis } from 'ioredis';
import { AppError, ErrorCode, PLATFORM_ROLES } from '@yocore/types';
import * as roleRepo from '../repos/role.repo.js';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';

const PLATFORM_SLUGS = new Set<string>(PLATFORM_ROLES.map((r) => r.slug));

const CACHE_INVALIDATE_CHANNEL = 'cache:invalidate';

export interface CreateRoleInput {
  productId: string;
  slug: string;
  name: string;
  description?: string | undefined;
  permissions: readonly string[];
  inheritsFrom?: string | undefined;
  isDefault?: boolean | undefined;
}

export interface UpdateRoleInput {
  productId: string;
  roleId: string;
  patch: {
    name?: string | undefined;
    description?: string | null | undefined;
    permissions?: readonly string[] | undefined;
    inheritsFrom?: string | null | undefined;
    isDefault?: boolean | undefined;
  };
}

export interface RoleService {
  list(productId: string): Promise<roleRepo.RoleLean[]>;
  create(input: CreateRoleInput): Promise<roleRepo.RoleLean>;
  update(input: UpdateRoleInput): Promise<roleRepo.RoleLean>;
  delete(productId: string, roleId: string): Promise<void>;
  /** Returns the count of ACTIVE workspace members carrying each role id. */
  memberCounts(productId: string): Promise<Record<string, number>>;
}

export interface CreateRoleServiceDeps {
  redis: Redis;
}

export function createRoleService(deps: CreateRoleServiceDeps): RoleService {
  async function broadcastInvalidation(productId: string): Promise<void> {
    // Wildcard signal: subscribers DEL any key starting with `perm:<productId>:`.
    // The current `subscribePermInvalidation` only handles exact-key DELs, so we
    // also push a sentinel key so the local cache turns over within TTL (60s).
    await deps.redis.publish(
      CACHE_INVALIDATE_CHANNEL,
      `perm:${productId}:__bulk__`,
    );
  }

  /**
   * Cycle + depth guard for `inheritsFrom` chains. Walks up to 4 hops; throws
   * VALIDATION_FAILED if a cycle is found or depth exceeded.
   */
  async function assertInheritanceValid(
    productId: string,
    selfId: string | null,
    inheritsFrom: string | null,
  ): Promise<void> {
    if (!inheritsFrom) return;
    let cursor: string | null = inheritsFrom;
    const seen = new Set<string>();
    if (selfId) seen.add(selfId);
    let depth = 0;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Inheritance cycle detected',
          { inheritsFrom },
        );
      }
      seen.add(cursor);
      depth += 1;
      if (depth > 4) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Inheritance chain too deep (max 4)',
          { inheritsFrom },
        );
      }
      const parent = await roleRepo.findById(productId, cursor);
      if (!parent) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'inheritsFrom role not found',
          { inheritsFrom: cursor },
        );
      }
      cursor = parent.inheritsFrom ?? null;
    }
  }

  return {
    async list(productId) {
      // Ensure platform roles exist (idempotent) so `list` always returns 4+.
      await roleRepo.ensurePlatformRoles(productId);
      return roleRepo.listForProduct(productId);
    },

    async create(input) {
      if (PLATFORM_SLUGS.has(input.slug)) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Slug is reserved by a platform role',
          { slug: input.slug },
        );
      }
      const existing = await roleRepo.findBySlug(input.productId, input.slug);
      if (existing) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Role slug already exists',
          { slug: input.slug },
        );
      }
      await assertInheritanceValid(
        input.productId,
        null,
        input.inheritsFrom ?? null,
      );
      const created = await roleRepo.createRole({
        productId: input.productId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        isPlatform: false,
        isDefault: input.isDefault ?? false,
        permissions: input.permissions,
        inheritsFrom: input.inheritsFrom ?? null,
      });
      await broadcastInvalidation(input.productId);
      return created;
    },

    async update(input) {
      const existing = await roleRepo.findById(input.productId, input.roleId);
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Role not found');
      }
      if (existing.isPlatform) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Platform roles are immutable',
        );
      }
      if (input.patch.inheritsFrom !== undefined && input.patch.inheritsFrom !== null) {
        await assertInheritanceValid(
          input.productId,
          input.roleId,
          input.patch.inheritsFrom,
        );
      }
      const updated = await roleRepo.updateRole(
        input.productId,
        input.roleId,
        input.patch,
      );
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, 'Role not found');
      await broadcastInvalidation(input.productId);
      return updated;
    },

    async delete(productId, roleId) {
      const existing = await roleRepo.findById(productId, roleId);
      if (!existing) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Role not found');
      }
      if (existing.isPlatform) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Platform roles cannot be deleted',
        );
      }
      const inUse = await workspaceMemberRepo.countActiveByRole(productId, roleId);
      if (inUse > 0) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Role has active members; reassign before deleting',
          { activeMembers: inUse },
        );
      }
      await roleRepo.deleteRole(productId, roleId);
      await broadcastInvalidation(productId);
    },

    async memberCounts(productId) {
      // Single aggregate over workspaceMembers for this product.
      const { WorkspaceMember } = await import('../db/models/WorkspaceMember.js');
      const rows = (await WorkspaceMember.aggregate([
        { $match: { productId, status: 'ACTIVE' } },
        { $group: { _id: '$roleId', n: { $sum: 1 } } },
      ])) as Array<{ _id: string; n: number }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r._id] = r.n;
      return out;
    },
  };
}
