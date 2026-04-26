/**
 * Phase 3.2 — Workspaces / Members / Invitations / Permissions (integration).
 *
 * Builds a real verified end-user via signup → verify-email → finalize-onboarding
 * (so we already have an OWNER membership in a workspace) and then drives
 * every Phase 3.2 endpoint to verify Flow L (CRUD + switch), Flow M (invite
 * + accept), Flow Z (transfer ownership), Flow AA (voluntary delete + restore),
 * platform role seeding, and `POST /v1/permissions/check`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { Product } from '../db/models/Product.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { Invitation } from '../db/models/Invitation.js';
import { Role } from '../db/models/Role.js';
import { EmailQueue } from '../db/models/EmailQueue.js';
import { hash as hashPassword } from '../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const SECOND_PASSWORD = 'AnotherStr0ng!';

async function makeProduct(slug: string): Promise<string> {
  const apiSecretHash = await hashPassword('dummy');
  const doc = await Product.create({
    name: `P-${slug}`,
    slug,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

interface OnboardedUser {
  userId: string;
  productId: string;
  workspaceId: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * End-to-end: signup → verify → finalize-onboarding. Returns full session +
 * the workspace created during finalize.
 */
async function onboardUser(
  email: string,
  password: string,
  productSlug: string,
  workspaceName = 'My WS',
): Promise<OnboardedUser> {
  const { app } = await getTestContext();
  await request(app)
    .post('/v1/auth/signup')
    .send({ email, password, productSlug });
  const queued = await EmailQueue.findOne({
    toAddress: email,
    templateId: 'auth.email_verify',
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!queued) {
    throw new Error(`No verify-email queued for ${email} / product ${productSlug}`);
  }
  const token = (queued.templateData as { verifyToken: string }).verifyToken;
  const verifyRes = await request(app).get('/v1/auth/verify-email').query({ token });
  expect(verifyRes.status).toBe(200);
  const accessToken = verifyRes.body.tokens.accessToken as string;

  const finalize = await request(app)
    .post('/v1/auth/finalize-onboarding')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ workspaceName, timezone: 'UTC' });
  expect(finalize.status).toBe(201);

  return {
    userId: verifyRes.body.userId,
    productId: verifyRes.body.productId,
    workspaceId: finalize.body.workspace.id,
    accessToken,
    refreshToken: verifyRes.body.tokens.refreshToken,
  };
}

describe('Phase 3.2 — workspaces / members / invitations / permissions', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('Flow L — workspace CRUD + switch', () => {
    it('finalize-onboarding seeds the four platform roles', async () => {
      await makeProduct('flowl');
      const u = await onboardUser('owner@example.com', PASSWORD, 'flowl');
      const roles = await Role.find({ productId: u.productId }).lean();
      const slugs = roles.map((r) => r.slug).sort();
      expect(slugs).toEqual(['ADMIN', 'MEMBER', 'OWNER', 'VIEWER']);
      const owner = roles.find((r) => r.slug === 'OWNER')!;
      expect(owner.permissions).toEqual(['*']);
    });

    it('GET /v1/workspaces lists the bootstrap workspace with role=OWNER', async () => {
      const { app } = await getTestContext();
      await makeProduct('list');
      const u = await onboardUser('owner@example.com', PASSWORD, 'list');
      const r = await request(app)
        .get('/v1/workspaces')
        .set('Authorization', `Bearer ${u.accessToken}`);
      expect(r.status).toBe(200);
      expect(r.body.workspaces).toHaveLength(1);
      expect(r.body.workspaces[0].id).toBe(u.workspaceId);
      expect(r.body.workspaces[0].role).toBe('OWNER');
    });

    it('POST /v1/workspaces creates a new workspace + OWNER membership', async () => {
      const { app } = await getTestContext();
      await makeProduct('create');
      const u = await onboardUser('owner@example.com', PASSWORD, 'create');
      const r = await request(app)
        .post('/v1/workspaces')
        .set('Authorization', `Bearer ${u.accessToken}`)
        .send({ name: 'Second WS', timezone: 'America/New_York' });
      expect(r.status).toBe(201);
      const wsId = r.body.workspace.id;
      const member = await WorkspaceMember.findOne({ workspaceId: wsId, userId: u.userId }).lean();
      expect(member?.roleSlug).toBe('OWNER');
    });

    it('PATCH /v1/workspaces/:id updates name + timezone', async () => {
      const { app } = await getTestContext();
      await makeProduct('upd');
      const u = await onboardUser('owner@example.com', PASSWORD, 'upd');
      const r = await request(app)
        .patch(`/v1/workspaces/${u.workspaceId}`)
        .set('Authorization', `Bearer ${u.accessToken}`)
        .send({ name: 'Renamed', timezone: 'Asia/Dhaka' });
      expect(r.status).toBe(200);
      expect(r.body.workspace.name).toBe('Renamed');
      expect(r.body.workspace.timezone).toBe('Asia/Dhaka');
    });

    it('POST /v1/auth/switch-workspace issues a fresh JWT scoped to the new workspace', async () => {
      const { app } = await getTestContext();
      await makeProduct('switch');
      const u = await onboardUser('owner@example.com', PASSWORD, 'switch');
      const created = await request(app)
        .post('/v1/workspaces')
        .set('Authorization', `Bearer ${u.accessToken}`)
        .send({ name: 'Other' });
      const otherId = created.body.workspace.id;

      const sw = await request(app)
        .post('/v1/auth/switch-workspace')
        .set('Authorization', `Bearer ${u.accessToken}`)
        .send({ workspaceId: otherId });
      expect(sw.status).toBe(200);
      expect(sw.body.workspaceId).toBe(otherId);
      expect(sw.body.accessToken).toBeTruthy();
      expect(sw.body.accessToken).not.toBe(u.accessToken);
    });
  });

  describe('Flow M — invitations', () => {
    it('OWNER invites a brand-new email; accept-new creates user+productUser+membership and issues a session', async () => {
      const { app } = await getTestContext();
      await makeProduct('inv');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'inv');

      const inv = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'newby@example.com', roleSlug: 'MEMBER' });
      expect(inv.status).toBe(201);
      expect(inv.body.invitation.isExistingUser).toBe(false);

      const queued = await EmailQueue.findOne({
        toAddress: 'newby@example.com',
        templateId: 'workspace.invitation_new',
      }).lean();
      expect(queued).not.toBeNull();
      const token = (queued!.templateData as { inviteToken: string }).inviteToken;

      const preview = await request(app)
        .get('/v1/invitations/preview')
        .query({ token });
      expect(preview.status).toBe(200);
      expect(preview.body.email).toBe('newby@example.com');
      expect(preview.body.isExistingUser).toBe(false);

      const accept = await request(app)
        .post('/v1/invitations/accept-new')
        .send({ token, password: SECOND_PASSWORD, name: { first: 'New', last: 'Body' } });
      expect(accept.status).toBe(201);
      expect(accept.body.status).toBe('accepted');
      expect(accept.body.workspaceId).toBe(owner.workspaceId);
      expect(accept.body.tokens.accessToken).toBeTruthy();

      const member = await WorkspaceMember.findOne({
        workspaceId: owner.workspaceId,
        userId: accept.body.userId,
      }).lean();
      expect(member?.roleSlug).toBe('MEMBER');
      expect(member?.status).toBe('ACTIVE');

      const inviteRow = await Invitation.findOne({ _id: inv.body.invitation.id }).lean();
      expect(inviteRow?.status).toBe('ACCEPTED');
    });

    it('OWNER invites an existing user (different product); accept attaches them via cross-product join', async () => {
      const { app } = await getTestContext();
      await makeProduct('inv-a');
      await makeProduct('inv-b');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'inv-a');
      // Existing user signs up for product B independently.
      const invitee = await onboardUser('invitee@example.com', SECOND_PASSWORD, 'inv-b');

      const inv = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'invitee@example.com', roleSlug: 'ADMIN' });
      expect(inv.status).toBe(201);
      expect(inv.body.invitation.isExistingUser).toBe(true);

      const queued = await EmailQueue.findOne({
        toAddress: 'invitee@example.com',
        templateId: 'workspace.invitation_existing',
      }).lean();
      const token = (queued!.templateData as { inviteToken: string }).inviteToken;

      // Invitee accepts using the invitation token with their existing session.
      const accept = await request(app)
        .post('/v1/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token });
      expect(accept.status).toBe(200);
      expect(accept.body.status).toBe('accepted');
      expect(accept.body.workspaceId).toBe(owner.workspaceId);

      const member = await WorkspaceMember.findOne({
        workspaceId: owner.workspaceId,
        userId: invitee.userId,
      }).lean();
      expect(member?.roleSlug).toBe('ADMIN');
    });

    it('cannot invite with roleSlug=OWNER (use transfer-ownership)', async () => {
      const { app } = await getTestContext();
      await makeProduct('inv-owner');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'inv-owner');

      const r = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'someone@example.com', roleSlug: 'OWNER' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('OWNER_ONLY');
    });

    it('revoking a pending invitation prevents it from being accepted', async () => {
      const { app } = await getTestContext();
      await makeProduct('rev');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'rev');

      const inv = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'rev@example.com', roleSlug: 'MEMBER' });
      const queued = await EmailQueue.findOne({ toAddress: 'rev@example.com' }).lean();
      const token = (queued!.templateData as { inviteToken: string }).inviteToken;

      const del = await request(app)
        .delete(`/v1/workspaces/${owner.workspaceId}/invitations/${inv.body.invitation.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(del.status).toBe(204);

      const accept = await request(app)
        .post('/v1/invitations/accept-new')
        .send({ token, password: SECOND_PASSWORD });
      expect(accept.status).toBe(409);
      expect(accept.body.error).toBe('INVITATION_ALREADY_USED');
    });
  });

  describe('Flow Z — transfer ownership', () => {
    it('OWNER transfers ownership to an existing ADMIN member', async () => {
      const { app } = await getTestContext();
      await makeProduct('xfer');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'xfer');

      // Invite a brand-new user as ADMIN, accept-new, then transfer.
      const invited = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'newadmin@example.com', roleSlug: 'ADMIN' });
      const inviteEmail = await EmailQueue.findOne({
        toAddress: 'newadmin@example.com',
        templateId: 'workspace.invitation_new',
      }).lean();
      const tok = (inviteEmail!.templateData as { inviteToken: string }).inviteToken;
      const accepted = await request(app)
        .post('/v1/invitations/accept-new')
        .send({ token: tok, password: SECOND_PASSWORD });
      expect(accepted.status).toBe(201);
      void invited;

      const xfer = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/transfer-ownership`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ newOwnerUserId: accepted.body.userId, password: PASSWORD });
      expect(xfer.status).toBe(200);
      expect(xfer.body.workspace.ownerUserId).toBe(accepted.body.userId);

      const oldOwner = await WorkspaceMember.findOne({
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      }).lean();
      expect(oldOwner?.roleSlug).toBe('ADMIN');
      const newOwner = await WorkspaceMember.findOne({
        workspaceId: owner.workspaceId,
        userId: accepted.body.userId,
      }).lean();
      expect(newOwner?.roleSlug).toBe('OWNER');
    });

    it('rejects transfer with wrong password', async () => {
      const { app } = await getTestContext();
      await makeProduct('xfer-bad');
      const owner = await onboardUser('o@example.com', PASSWORD, 'xfer-bad');
      // Invite & accept a new admin first
      await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: 'a2@example.com', roleSlug: 'ADMIN' });
      const q = await EmailQueue.findOne({ toAddress: 'a2@example.com' }).lean();
      const t = (q!.templateData as { inviteToken: string }).inviteToken;
      const accepted = await request(app)
        .post('/v1/invitations/accept-new')
        .send({ token: t, password: SECOND_PASSWORD });

      const r = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/transfer-ownership`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ newOwnerUserId: accepted.body.userId, password: 'WrongPass1!' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('AUTH_INVALID_CREDENTIALS');
    });
  });

  describe('Flow AA — voluntary deletion + restore', () => {
    it('OWNER schedules deletion (30d grace), then restores within window', async () => {
      const { app } = await getTestContext();
      await makeProduct('aa');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'aa', 'Doomed');

      const del = await request(app)
        .delete(`/v1/workspaces/${owner.workspaceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ password: PASSWORD, confirmName: 'Doomed' });
      expect(del.status).toBe(200);
      expect(del.body.workspace.status).toBe('DELETED');
      expect(del.body.workspace.suspended).toBe(true);
      expect(del.body.workspace.voluntaryDeletionFinalizesAt).toBeTruthy();

      const restored = await request(app)
        .post(`/v1/workspaces/${owner.workspaceId}/restore`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(restored.status).toBe(200);
      expect(restored.body.workspace.status).toBe('ACTIVE');
      expect(restored.body.workspace.suspended).toBe(false);
    });

    it('rejects deletion when confirmName mismatch', async () => {
      const { app } = await getTestContext();
      await makeProduct('aa-bad');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'aa-bad', 'RealName');

      const r = await request(app)
        .delete(`/v1/workspaces/${owner.workspaceId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ password: PASSWORD, confirmName: 'WrongName' });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('VALIDATION_FAILED');
    });
  });

  describe('Permissions check + catalog', () => {
    it('OWNER receives the wildcard for any permission via /v1/permissions/check', async () => {
      const { app } = await getTestContext();
      await makeProduct('perm');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'perm');

      const r = await request(app)
        .post('/v1/permissions/check')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          permissions: ['workspace.read', 'billing.update', 'role.delete'],
        });
      expect(r.status).toBe(200);
      expect(r.body.results['workspace.read']).toBe(true);
      expect(r.body.results['billing.update']).toBe(true);
      expect(r.body.results['role.delete']).toBe(true);
    });

    it('non-member returns false for every permission', async () => {
      const { app } = await getTestContext();
      await makeProduct('perm2');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'perm2');

      const r = await request(app)
        .post('/v1/permissions/check')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          userId: 'usr_does_not_exist',
          workspaceId: owner.workspaceId,
          permissions: ['workspace.read'],
        });
      expect(r.status).toBe(200);
      expect(r.body.results['workspace.read']).toBe(false);
    });

    it('catalog lists the four platform roles + their permissions', async () => {
      const { app } = await getTestContext();
      await makeProduct('cat');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'cat');

      const r = await request(app)
        .get('/v1/permissions/catalog')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(r.status).toBe(200);
      const slugs = (r.body.roles as Array<{ slug: string }>).map((x) => x.slug).sort();
      expect(slugs).toEqual(['ADMIN', 'MEMBER', 'OWNER', 'VIEWER']);
      expect(r.body.permissions).toContain('workspace.read');
    });
  });

  describe('Members — change role + remove', () => {
    async function inviteMember(
      ownerToken: string,
      workspaceId: string,
      email: string,
      role: 'ADMIN' | 'MEMBER' | 'VIEWER' = 'MEMBER',
    ): Promise<string> {
      const { app } = await getTestContext();
      await request(app)
        .post(`/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email, roleSlug: role });
      const q = await EmailQueue.findOne({
        toAddress: email,
        templateId: 'workspace.invitation_new',
      })
        .sort({ createdAt: -1 })
        .lean();
      const t = (q!.templateData as { inviteToken: string }).inviteToken;
      const acc = await request(app)
        .post('/v1/invitations/accept-new')
        .send({ token: t, password: SECOND_PASSWORD });
      return acc.body.userId as string;
    }

    it('OWNER changes a MEMBER to ADMIN, then removes them', async () => {
      const { app } = await getTestContext();
      await makeProduct('mbr');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'mbr');
      const mUserId = await inviteMember(owner.accessToken, owner.workspaceId, 'm@example.com');

      const ch = await request(app)
        .patch(`/v1/workspaces/${owner.workspaceId}/members/${mUserId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ roleSlug: 'ADMIN' });
      expect(ch.status).toBe(200);
      expect(ch.body.member.roleSlug).toBe('ADMIN');

      const rm = await request(app)
        .delete(`/v1/workspaces/${owner.workspaceId}/members/${mUserId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(rm.status).toBe(204);
      const dbRow = await WorkspaceMember.findOne({
        workspaceId: owner.workspaceId,
        userId: mUserId,
      }).lean();
      expect(dbRow?.status).toBe('REMOVED');
    });

    it('cannot remove the OWNER member', async () => {
      const { app } = await getTestContext();
      await makeProduct('mbr2');
      const owner = await onboardUser('owner@example.com', PASSWORD, 'mbr2');

      const r = await request(app)
        .delete(`/v1/workspaces/${owner.workspaceId}/members/${owner.userId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('OWNER_ONLY');
    });
  });
});

// Suppress an unused import warning if Workspace import not referenced.
void Workspace;
