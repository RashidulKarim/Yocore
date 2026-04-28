/**
 * Member service — list / change role / remove for a workspace.
 *
 * Caller must be ADMIN+ in the target workspace; demoting/removing the OWNER
 * is forbidden (use Flow Z transferOwnership first).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as roleRepo from '../repos/role.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { ROLE_RANK, WebhookEventTypes } from '@yocore/types';

export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  roleSlug: string;
  status: 'ACTIVE' | 'INVITED' | 'REMOVED';
  joinedAt: Date;
}

export interface MemberServiceDeps {
  invalidatePermissions: (productId: string, userId: string, workspaceId: string) => Promise<void>;
}

export interface MemberService {
  list(productId: string, callerId: string, workspaceId: string): Promise<MemberSummary[]>;
  changeRole(input: {
    productId: string;
    callerId: string;
    workspaceId: string;
    targetUserId: string;
    roleSlug: string;
  }): Promise<MemberSummary>;
  remove(input: {
    productId: string;
    callerId: string;
    workspaceId: string;
    targetUserId: string;
  }): Promise<void>;
}

async function ensureCallerCanManage(
  productId: string,
  callerId: string,
  workspaceId: string,
): Promise<{ rank: number }> {
  const member = await workspaceMemberRepo.findMember(productId, workspaceId, callerId);
  if (!member || member.status !== 'ACTIVE') {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
  }
  const rank = ROLE_RANK[member.roleSlug] ?? 0;
  if (rank < ROLE_RANK['ADMIN']!) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'Admin or owner required');
  }
  return { rank };
}

async function buildSummary(
  productId: string,
  m: workspaceMemberRepo.WorkspaceMemberLean,
): Promise<MemberSummary> {
  const u = await userRepo.findUserById(m.userId);
  const pu = await productUserRepo.findByUserAndProduct(productId, m.userId);
  const display =
    pu?.name?.display ??
    [pu?.name?.first, pu?.name?.last].filter(Boolean).join(' ') ??
    null;
  return {
    userId: m.userId,
    email: u?.email ?? '',
    name: display && display.length > 0 ? display : null,
    roleSlug: m.roleSlug,
    status: m.status as MemberSummary['status'],
    joinedAt: m.joinedAt,
  };
}

export function createMemberService(deps: MemberServiceDeps): MemberService {
  return {
    async list(productId, callerId, workspaceId) {
      // Members listing requires only membership (not ADMIN).
      const member = await workspaceMemberRepo.findMember(productId, workspaceId, callerId);
      if (!member || member.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
      }
      const rows = await workspaceMemberRepo.listForWorkspace(productId, workspaceId);
      return Promise.all(rows.map((r) => buildSummary(productId, r)));
    },

    async changeRole(input) {
      const { rank: callerRank } = await ensureCallerCanManage(
        input.productId,
        input.callerId,
        input.workspaceId,
      );
      const ws = await workspaceRepo.findById(input.productId, input.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');

      if (input.targetUserId === ws.ownerUserId) {
        throw new AppError(
          ErrorCode.OWNER_ONLY,
          'Cannot change owner role — use transfer-ownership instead',
        );
      }
      if (input.roleSlug === 'OWNER') {
        throw new AppError(
          ErrorCode.OWNER_ONLY,
          'Granting OWNER requires transfer-ownership',
        );
      }
      // Disallow promoting someone above the caller's own rank.
      const newRank = ROLE_RANK[input.roleSlug] ?? 0;
      if (newRank >= callerRank) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Cannot grant a role at or above your own',
        );
      }

      const target = await workspaceMemberRepo.findMember(
        input.productId,
        input.workspaceId,
        input.targetUserId,
      );
      if (!target || target.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
      }

      // Resolve roleId for the requested slug.
      const role = await roleRepo.findBySlug(input.productId, input.roleSlug);
      if (!role) throw new AppError(ErrorCode.NOT_FOUND, `Role ${input.roleSlug} not defined`);

      const updated = await workspaceMemberRepo.setRole(
        input.productId,
        input.workspaceId,
        input.targetUserId,
        role._id,
        role.slug,
      );
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');

      await deps.invalidatePermissions(
        input.productId,
        input.targetUserId,
        input.workspaceId,
      );

      // Emit webhook so external subscribers can invalidate cached permissions.
      await emitMemberRoleChangedWebhook({
        productId: input.productId,
        workspaceId: input.workspaceId,
        userId: input.targetUserId,
        previousRoleSlug: target.roleSlug,
        newRoleSlug: role.slug,
        changedByUserId: input.callerId,
      });

      return buildSummary(input.productId, updated);
    },

    async remove(input) {
      await ensureCallerCanManage(input.productId, input.callerId, input.workspaceId);
      const ws = await workspaceRepo.findById(input.productId, input.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      if (input.targetUserId === ws.ownerUserId) {
        throw new AppError(ErrorCode.OWNER_ONLY, 'Cannot remove the workspace owner');
      }
      const ok = await workspaceMemberRepo.removeMember(
        input.productId,
        input.workspaceId,
        input.targetUserId,
        input.callerId,
      );
      if (!ok) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
      await deps.invalidatePermissions(
        input.productId,
        input.targetUserId,
        input.workspaceId,
      );
    },
  };
}

/**
 * Enqueue a `workspace.member_role_changed` outbound webhook. Best-effort:
 * never throws; never blocks the role-change response. Mirrors the inline
 * `emitWebhook` pattern used by subscription services (seat-change, refund).
 */
async function emitMemberRoleChangedWebhook(input: {
  productId: string;
  workspaceId: string;
  userId: string;
  previousRoleSlug: string;
  newRoleSlug: string;
  changedByUserId: string;
}): Promise<void> {
  try {
    const product = await productRepo.findProductById(input.productId);
    if (!product?.webhookUrl) return;
    const now = new Date();
    await deliveryRepo.enqueueDelivery({
      productId: input.productId,
      event: WebhookEventTypes.WORKSPACE_MEMBER_ROLE_CHANGED,
      eventId: `evt_wsrole_${input.workspaceId}_${input.userId}_${now.getTime()}`,
      url: product.webhookUrl,
      payloadRef: input.workspaceId,
      payload: {
        workspaceId: input.workspaceId,
        productId: input.productId,
        userId: input.userId,
        previousRoleSlug: input.previousRoleSlug,
        newRoleSlug: input.newRoleSlug,
        changedByUserId: input.changedByUserId,
        changedAt: now.toISOString(),
      },
    });
  } catch {
    // Swallow — webhook emission must never break the request.
  }
}
