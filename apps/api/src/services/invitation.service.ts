/**
 * Invitation service — Flow M (create + accept paths).
 *
 * Two acceptance flows:
 *   - Path A — Existing user (`isExistingUser:true`) accepts the invite while
 *     authenticated. Creates a `productUsers` row if missing (handles cross-
 *     product join during the same call) + a `workspaceMembers` row.
 *   - Path B — New user signs up via the invitation, providing a password.
 *     Creates `users` + `productUsers` + `workspaceMembers` and returns a
 *     fresh signed-in session.
 */
import type { AuthService } from './auth.service.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { hash as hashPassword } from '../lib/password.js';
import { generateTokenWithHash, hashToken } from '../lib/tokens.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as roleRepo from '../repos/role.repo.js';
import * as invitationRepo from '../repos/invitation.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import * as productRepo from '../repos/product.repo.js';
import { ROLE_RANK } from '@yocore/types';

const INVITATION_TTL_HOURS = 72;

export interface InvitationServiceDeps {
  auth: AuthService;
  defaultFromAddress: string;
  invalidatePermissions: (productId: string, userId: string, workspaceId: string) => Promise<void>;
}

export interface CreateInvitationInput {
  productId: string;
  callerId: string;
  workspaceId: string;
  email: string;
  roleSlug: string;
}

export interface InvitationPreview {
  workspaceId: string;
  workspaceName: string;
  productId: string;
  email: string;
  roleSlug: string;
  isExistingUser: boolean;
  expiresAt: Date;
}

export interface AcceptInvitationOutcome {
  workspaceId: string;
  productId: string;
  userId: string;
  alreadyMember: boolean;
}

export interface AcceptInvitationNewInput {
  token: string;
  password: string;
  name?: { first?: string; last?: string };
  device: { ip: string | null; userAgent: string | null };
}

export interface InvitationService {
  create(input: CreateInvitationInput): Promise<{
    invitation: invitationRepo.InvitationLean;
    rawToken: string;
  }>;
  list(productId: string, callerId: string, workspaceId: string): Promise<invitationRepo.InvitationLean[]>;
  revoke(input: {
    productId: string;
    callerId: string;
    workspaceId: string;
    invitationId: string;
  }): Promise<void>;
  preview(rawToken: string): Promise<InvitationPreview>;
  accept(input: { token: string; userId: string }): Promise<AcceptInvitationOutcome>;
  acceptNew(input: AcceptInvitationNewInput): Promise<{
    outcome: AcceptInvitationOutcome;
    session: Awaited<ReturnType<AuthService['issueSession']>>;
  }>;
}

async function ensureCallerCanInvite(
  productId: string,
  callerId: string,
  workspaceId: string,
): Promise<void> {
  const member = await workspaceMemberRepo.findMember(productId, workspaceId, callerId);
  if (!member || member.status !== 'ACTIVE') {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
  }
  const rank = ROLE_RANK[member.roleSlug] ?? 0;
  if (rank < ROLE_RANK['ADMIN']!) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'Admin or owner required');
  }
}

export function createInvitationService(deps: InvitationServiceDeps): InvitationService {
  return {
    async create(input) {
      await ensureCallerCanInvite(input.productId, input.callerId, input.workspaceId);
      const ws = await workspaceRepo.findById(input.productId, input.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      if (ws.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace is not active');
      }
      if (input.roleSlug === 'OWNER') {
        throw new AppError(
          ErrorCode.OWNER_ONLY,
          'Granting OWNER requires transfer-ownership',
        );
      }

      const role = await roleRepo.findBySlug(input.productId, input.roleSlug);
      if (!role) {
        // Auto-seed platform roles on first invite to avoid 500s on fresh products.
        const seeded = await roleRepo.ensurePlatformRoles(input.productId);
        const fallback = seeded[input.roleSlug as keyof typeof seeded];
        if (!fallback) {
          throw new AppError(ErrorCode.NOT_FOUND, `Role ${input.roleSlug} not defined`);
        }
      }
      const resolvedRole =
        role ?? (await roleRepo.findBySlug(input.productId, input.roleSlug));
      if (!resolvedRole) {
        throw new AppError(ErrorCode.NOT_FOUND, `Role ${input.roleSlug} not defined`);
      }

      // Detect existing global user — affects template + acceptance path.
      const existingUser = await userRepo.findUserByEmail(input.email);
      if (existingUser) {
        const dup = await workspaceMemberRepo.findMember(
          input.productId,
          input.workspaceId,
          existingUser._id,
        );
        if (dup && dup.status === 'ACTIVE') {
          throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'User is already a workspace member');
        }
      }

      const { token, tokenHash } = generateTokenWithHash(32);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3_600_000);
      const invitation = await invitationRepo.upsertPendingInvitation({
        productId: input.productId,
        workspaceId: input.workspaceId,
        email: input.email.trim().toLowerCase(),
        roleId: resolvedRole._id,
        roleSlug: resolvedRole.slug,
        invitedBy: input.callerId,
        tokenHash,
        isExistingUser: existingUser !== null,
        expiresAt,
      });

      // Best-effort email — never block the invite on enqueue failure.
      try {
        const product = await productRepo.findProductById(input.productId);
        await emailQueueRepo.enqueueEmail({
          productId: input.productId,
          userId: existingUser?._id ?? null,
          toAddress: input.email,
          fromAddress: product?.settings?.fromEmail ?? deps.defaultFromAddress,
          fromName: product?.settings?.fromName ?? product?.name ?? 'YoCore',
          subject: `You've been invited to join ${ws.name}`,
          templateId: existingUser
            ? 'workspace.invitation_existing'
            : 'workspace.invitation_new',
          category: 'transactional',
          priority: 'normal',
          templateData: {
            workspaceId: input.workspaceId,
            workspaceName: ws.name,
            roleSlug: resolvedRole.slug,
            inviteToken: token,
            expiresAt: expiresAt.toISOString(),
          },
        });
      } catch {
        // swallow — invitation is created, email retry happens out-of-band.
      }

      return { invitation, rawToken: token };
    },

    async list(productId, callerId, workspaceId) {
      await ensureCallerCanInvite(productId, callerId, workspaceId);
      return invitationRepo.listForWorkspace(productId, workspaceId);
    },

    async revoke(input) {
      await ensureCallerCanInvite(input.productId, input.callerId, input.workspaceId);
      const inv = await invitationRepo.findById(input.invitationId);
      if (!inv || inv.workspaceId !== input.workspaceId) {
        throw new AppError(ErrorCode.INVITATION_NOT_FOUND, 'Invitation not found');
      }
      if (inv.status !== 'PENDING') {
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation is no longer pending');
      }
      await invitationRepo.markRevoked(input.invitationId, input.callerId);
    },

    async preview(rawToken) {
      const inv = await invitationRepo.findByTokenHash(hashToken(rawToken));
      if (!inv) throw new AppError(ErrorCode.INVITATION_NOT_FOUND, 'Invitation not found');
      if (inv.status === 'REVOKED') {
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation revoked');
      }
      if (inv.status === 'ACCEPTED') {
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation already used');
      }
      if (inv.expiresAt.getTime() <= Date.now()) {
        throw new AppError(ErrorCode.INVITATION_EXPIRED, 'Invitation expired');
      }
      const ws = await workspaceRepo.findById(inv.productId, inv.workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
      return {
        workspaceId: inv.workspaceId,
        workspaceName: ws.name,
        productId: inv.productId,
        email: inv.email,
        roleSlug: inv.roleSlug,
        isExistingUser: inv.isExistingUser,
        expiresAt: inv.expiresAt,
      };
    },

    async accept(input) {
      const inv = await invitationRepo.findByTokenHash(hashToken(input.token));
      if (!inv) throw new AppError(ErrorCode.INVITATION_NOT_FOUND, 'Invitation not found');
      if (inv.status === 'REVOKED') {
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation revoked');
      }
      if (inv.status === 'ACCEPTED') {
        // Idempotent: if the same user re-clicks, return the existing membership.
        const existing = await workspaceMemberRepo.findMember(
          inv.productId,
          inv.workspaceId,
          input.userId,
        );
        if (existing && existing.status === 'ACTIVE') {
          return {
            workspaceId: inv.workspaceId,
            productId: inv.productId,
            userId: input.userId,
            alreadyMember: true,
          };
        }
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation already used');
      }
      if (inv.expiresAt.getTime() <= Date.now()) {
        throw new AppError(ErrorCode.INVITATION_EXPIRED, 'Invitation expired');
      }

      // Email match — caller's account email must equal invite target.
      const user = await userRepo.findUserById(input.userId);
      if (!user || user.email !== inv.email) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Invitation email mismatch');
      }

      // Cross-product join: ensure productUser row exists. Onboarded=true so
      // they don't get sent to onboarding for an invited workspace.
      const existingPu = await productUserRepo.findByUserAndProduct(inv.productId, input.userId);
      if (!existingPu) {
        await productUserRepo.createProductUser({
          productId: inv.productId,
          userId: input.userId,
          // Existing user already has password hash on productUsers for the
          // products they signed up for; for invitation-only joins, mirror
          // their first product's hash isn't appropriate. We use a sentinel
          // and force the user to reset password if they ever want to sign in
          // via password to this product (until SSO is built).
          passwordHash:
            'argon2id$invited$' /* unverifiable sentinel — forces password reset */,
        });
        await productUserRepo.activate(inv.productId, input.userId);
      }

      const member = await workspaceMemberRepo.upsertMember({
        workspaceId: inv.workspaceId,
        productId: inv.productId,
        userId: input.userId,
        roleId: inv.roleId,
        roleSlug: inv.roleSlug,
        addedBy: inv.invitedBy,
      });
      await invitationRepo.markAccepted(inv._id, input.userId);
      await deps.invalidatePermissions(inv.productId, input.userId, inv.workspaceId);

      return {
        workspaceId: inv.workspaceId,
        productId: inv.productId,
        userId: input.userId,
        alreadyMember: member !== null && member.joinedAt.getTime() < Date.now() - 1000,
      };
    },

    async acceptNew(input) {
      const inv = await invitationRepo.findByTokenHash(hashToken(input.token));
      if (!inv) throw new AppError(ErrorCode.INVITATION_NOT_FOUND, 'Invitation not found');
      if (inv.status !== 'PENDING') {
        throw new AppError(ErrorCode.INVITATION_ALREADY_USED, 'Invitation already used or revoked');
      }
      if (inv.expiresAt.getTime() <= Date.now()) {
        throw new AppError(ErrorCode.INVITATION_EXPIRED, 'Invitation expired');
      }
      if (inv.isExistingUser) {
        throw new AppError(
          ErrorCode.INVITATION_ALREADY_USED,
          'This invitation must be accepted by an existing account — sign in first',
        );
      }

      const passwordHash = await hashPassword(input.password);

      // If a global user exists for this email already (race), reject — caller
      // should use the existing-user accept flow instead.
      const existing = await userRepo.findUserByEmail(inv.email);
      if (existing) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Account already exists — sign in to accept',
        );
      }

      const user = await userRepo.createUser({
        email: inv.email,
        passwordHash: null,
        role: 'END_USER',
        emailVerified: true,
        emailVerifiedMethod: 'invitation',
      });

      await productUserRepo.createProductUser({
        productId: inv.productId,
        userId: user._id,
        passwordHash,
        ...(input.name !== undefined ? { name: input.name } : {}),
      });
      await productUserRepo.activate(inv.productId, user._id);
      await productUserRepo.markOnboarded(inv.productId, user._id);

      await workspaceMemberRepo.upsertMember({
        workspaceId: inv.workspaceId,
        productId: inv.productId,
        userId: user._id,
        roleId: inv.roleId,
        roleSlug: inv.roleSlug,
        addedBy: inv.invitedBy,
      });
      await invitationRepo.markAccepted(inv._id, user._id);
      await deps.invalidatePermissions(inv.productId, user._id, inv.workspaceId);

      const session = await deps.auth.issueSession({
        userId: user._id,
        role: 'END_USER',
        productId: inv.productId,
        rememberMe: false,
        device: input.device,
      });

      return {
        outcome: {
          workspaceId: inv.workspaceId,
          productId: inv.productId,
          userId: user._id,
          alreadyMember: false,
        },
        session,
      };
    },
  };
}
