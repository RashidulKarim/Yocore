/**
 * Workspace service — Flow L (CRUD + switch), Flow Z (transfer ownership),
 * Flow AA (voluntary deletion + restore).
 *
 * Layer rule: this file owns the business logic; it never touches Express.
 *
 * Quota note: Flow L1 says "subscription.limits.maxWorkspaces". Since the
 * subscription system lands in Phase 3.4, the quota helper here returns the
 * env-configured default (`WORKSPACE_DEFAULT_MAX_PER_OWNER`, -1 = unlimited).
 * Phase 3.4 will swap in the real plan-driven check.
 */
import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '../lib/errors.js';
import { signJwt } from '../lib/jwt.js';
import { generateToken } from '../lib/tokens.js';
import { verify as verifyPassword } from '../lib/password.js';
import type { JwtKeyring } from '../lib/jwt-keyring.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as invitationRepo from '../repos/invitation.repo.js';
import * as sessionRepo from '../repos/session.repo.js';
import * as roleRepo from '../repos/role.repo.js';
import { deriveSlug } from './finalize-onboarding.service.js';
import { ROLE_RANK } from '@yocore/types';

const VOLUNTARY_DELETION_GRACE_DAYS = 30;

export interface WorkspaceServiceDeps {
  redis: Redis;
  keyring: JwtKeyring;
  accessTtlSeconds: number;
  defaultMaxWorkspacesPerOwner: number; // -1 = unlimited
  markSessionActive: (jti: string, ttl: number) => Promise<void>;
  markSessionRevoked: (jti: string) => Promise<void>;
  invalidatePermissions: (productId: string, userId: string, workspaceId: string) => Promise<void>;
}

export interface CreateWorkspaceInput {
  productId: string;
  userId: string;
  name: string;
  slug?: string;
  timezone?: string;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  productId: string;
  userId: string;
  workspaceId: string;
  name?: string;
  timezone?: string;
  settings?: Record<string, unknown>;
}

export interface DeleteWorkspaceInput {
  productId: string;
  userId: string;
  workspaceId: string;
  password: string;
  confirmName: string;
}

export interface TransferOwnershipInput {
  productId: string;
  userId: string;
  workspaceId: string;
  newOwnerUserId: string;
  password: string;
}

export interface SwitchWorkspaceInput {
  productId: string;
  userId: string;
  workspaceId: string;
  oldJti: string;
}

export interface SwitchWorkspaceOutcome {
  workspaceId: string;
  newJti: string;
  accessToken: string;
  expiresIn: number;
}

export interface WorkspaceService {
  create: (input: CreateWorkspaceInput) => Promise<workspaceRepo.WorkspaceLean>;
  list: (productId: string, userId: string) => Promise<Array<workspaceRepo.WorkspaceLean & { roleSlug: string }>>;
  get: (productId: string, userId: string, workspaceId: string) => Promise<workspaceRepo.WorkspaceLean>;
  update: (input: UpdateWorkspaceInput) => Promise<workspaceRepo.WorkspaceLean>;
  voluntaryDelete: (input: DeleteWorkspaceInput) => Promise<workspaceRepo.WorkspaceLean>;
  restore: (productId: string, userId: string, workspaceId: string) => Promise<workspaceRepo.WorkspaceLean>;
  transferOwnership: (input: TransferOwnershipInput) => Promise<workspaceRepo.WorkspaceLean>;
  switchWorkspace: (input: SwitchWorkspaceInput) => Promise<SwitchWorkspaceOutcome>;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  async function ensureOwner(
    productId: string,
    workspaceId: string,
    userId: string,
  ): Promise<workspaceRepo.WorkspaceLean> {
    const ws = await workspaceRepo.findById(productId, workspaceId);
    if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
    if (ws.ownerUserId !== userId) {
      throw new AppError(ErrorCode.OWNER_ONLY, 'Only the workspace owner can perform this action');
    }
    return ws;
  }

  async function reauthPassword(productId: string, userId: string, password: string): Promise<void> {
    const pu = await productUserRepo.findByUserAndProduct(productId, userId);
    if (!pu?.passwordHash) {
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Re-authentication failed');
    }
    const ok = await verifyPassword(pu.passwordHash, password);
    if (!ok) {
      throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Re-authentication failed');
    }
  }

  return {
    async create(input) {
      // Quota (Flow L1) — placeholder: Phase 3.4 will resolve from subscription.
      if (deps.defaultMaxWorkspacesPerOwner > 0) {
        const owned = await workspaceRepo.countOwnedActive(input.productId, input.userId);
        if (owned >= deps.defaultMaxWorkspacesPerOwner) {
          throw new AppError(
            ErrorCode.WORKSPACE_LIMIT_EXCEEDED,
            'Workspace limit reached for this product',
          );
        }
      }

      const slug = (input.slug ?? deriveSlug(input.name)).slice(0, 64);
      if (await workspaceRepo.slugExists(input.productId, slug)) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace slug already taken');
      }

      const platformRoles = await roleRepo.ensurePlatformRoles(input.productId);
      const ownerRole = platformRoles.OWNER;

      const ws = await workspaceRepo.createWorkspace({
        productId: input.productId,
        name: input.name,
        slug,
        ownerUserId: input.userId,
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.settings !== undefined ? { settings: input.settings } : {}),
      });

      await workspaceMemberRepo.createMember({
        workspaceId: ws._id,
        productId: input.productId,
        userId: input.userId,
        roleId: ownerRole._id,
        roleSlug: ownerRole.slug,
        addedBy: null,
      });

      await deps.invalidatePermissions(input.productId, input.userId, ws._id);
      return ws;
    },

    async list(productId, userId) {
      const memberships = await workspaceMemberRepo.listForUser(productId, userId);
      if (memberships.length === 0) return [];
      const out: Array<workspaceRepo.WorkspaceLean & { roleSlug: string }> = [];
      for (const m of memberships) {
        const ws = await workspaceRepo.findById(productId, m.workspaceId);
        if (ws && ws.status !== 'DELETED') out.push({ ...ws, roleSlug: m.roleSlug });
      }
      return out;
    },

    async get(productId, userId, workspaceId) {
      const member = await workspaceMemberRepo.findMember(productId, workspaceId, userId);
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      }
      const ws = await workspaceRepo.findById(productId, workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      return ws;
    },

    async update(input) {
      const ws = await workspaceRepo.findById(input.productId, input.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      const member = await workspaceMemberRepo.findMember(
        input.productId,
        input.workspaceId,
        input.userId,
      );
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
      }
      const rank = ROLE_RANK[member.roleSlug] ?? 0;
      if (rank < ROLE_RANK['ADMIN']!) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Admin or owner required');
      }
      const updated = await workspaceRepo.updateProfile(input.productId, input.workspaceId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.settings !== undefined ? { settings: input.settings } : {}),
      });
      if (!updated) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      return updated;
    },

    async voluntaryDelete(input) {
      const ws = await ensureOwner(input.productId, input.workspaceId, input.userId);
      if (ws.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace is not active');
      }
      if (input.confirmName !== ws.name) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'confirmName must equal workspace.name');
      }
      await reauthPassword(input.productId, input.userId, input.password);

      const finalizesAt = new Date(Date.now() + VOLUNTARY_DELETION_GRACE_DAYS * 86_400_000);
      const updated = await workspaceRepo.markVoluntaryDeletion(
        input.productId,
        input.workspaceId,
        finalizesAt,
      );
      if (!updated) throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace not active');

      await invitationRepo.revokePendingForWorkspace(input.workspaceId, input.userId);
      // Invalidate every member's perm cache for this workspace.
      const members = await workspaceMemberRepo.listForWorkspace(input.productId, input.workspaceId);
      for (const m of members) {
        await deps.invalidatePermissions(input.productId, m.userId, input.workspaceId);
      }
      return updated;
    },

    async restore(productId, userId, workspaceId) {
      const ws = await workspaceRepo.findById(productId, workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      if (ws.ownerUserId !== userId) {
        throw new AppError(ErrorCode.OWNER_ONLY, 'Only the workspace owner can restore');
      }
      if (ws.status !== 'DELETED' || ws.suspensionReason !== 'voluntary_deletion') {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace is not in voluntary-deletion state');
      }
      if (ws.dataDeleted) {
        throw new AppError(ErrorCode.GDPR_DELETION_BLOCKED, 'Data already purged — cannot restore');
      }
      const restored = await workspaceRepo.restoreVoluntaryDeletion(productId, workspaceId);
      if (!restored) throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Restore failed');
      const members = await workspaceMemberRepo.listForWorkspace(productId, workspaceId);
      for (const m of members) {
        await deps.invalidatePermissions(productId, m.userId, workspaceId);
      }
      return restored;
    },

    async transferOwnership(input) {
      const ws = await ensureOwner(input.productId, input.workspaceId, input.userId);
      if (input.newOwnerUserId === input.userId) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Cannot transfer to self');
      }
      await reauthPassword(input.productId, input.userId, input.password);

      const newOwnerMember = await workspaceMemberRepo.findMember(
        input.productId,
        input.workspaceId,
        input.newOwnerUserId,
      );
      if (!newOwnerMember || newOwnerMember.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'New owner must be an active member');
      }
      const newOwnerRank = ROLE_RANK[newOwnerMember.roleSlug] ?? 0;
      if (newOwnerRank < ROLE_RANK['ADMIN']!) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'New owner must currently be at least ADMIN');
      }

      const platformRoles = await roleRepo.ensurePlatformRoles(input.productId);
      const ownerRole = platformRoles.OWNER;
      const adminRole = platformRoles.ADMIN;

      // Sequential updates — idempotent in practice (fields are absolute set).
      // A real Mongo transaction will be added once Subscription mutations
      // join this critical section in Phase 3.4.
      await workspaceMemberRepo.setRole(
        input.productId,
        input.workspaceId,
        input.newOwnerUserId,
        ownerRole._id,
        ownerRole.slug,
      );
      await workspaceMemberRepo.setRole(
        input.productId,
        input.workspaceId,
        input.userId,
        adminRole._id,
        adminRole.slug,
      );
      const updated = await workspaceRepo.setOwner(
        input.productId,
        input.workspaceId,
        input.newOwnerUserId,
      );
      if (!updated) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace vanished');

      await deps.invalidatePermissions(input.productId, input.userId, input.workspaceId);
      await deps.invalidatePermissions(input.productId, input.newOwnerUserId, input.workspaceId);
      // Suppress noop var warning
      void ws;
      return updated;
    },

    async switchWorkspace(input) {
      const member = await workspaceMemberRepo.findMember(
        input.productId,
        input.workspaceId,
        input.userId,
      );
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
      }
      const ws = await workspaceRepo.findById(input.productId, input.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      if (ws.status !== 'ACTIVE' || ws.suspended) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace is suspended or deleted');
      }

      const newJti = `jti_${generateToken(16)}`;
      const swapped = await sessionRepo.swapJti({
        oldJti: input.oldJti,
        newJti,
        workspaceId: input.workspaceId,
      });
      if (!swapped) {
        throw new AppError(ErrorCode.AUTH_TOKEN_REVOKED, 'Session is no longer active');
      }

      // Invalidate old jti, mark new active.
      await deps.markSessionRevoked(input.oldJti);
      await deps.markSessionActive(newJti, deps.accessTtlSeconds);

      const accessToken = await signJwt(deps.keyring, {
        subject: input.userId,
        ttlSeconds: deps.accessTtlSeconds,
        purpose: 'access',
        jti: newJti,
        claims: {
          role: 'END_USER',
          pid: input.productId,
          wid: input.workspaceId,
          sid: newJti,
        },
      });

      return {
        workspaceId: input.workspaceId,
        newJti,
        accessToken,
        expiresIn: deps.accessTtlSeconds,
      };
    },
  };
}
