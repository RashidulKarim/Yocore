/**
 * Invitation repository — `invitations` collection.
 *
 * Tokens are stored as sha256 hashes (`tokenHash`); the raw token is only
 * shown in the email link and never returned via API after creation.
 */
import { Invitation, type InvitationDoc } from '../db/models/Invitation.js';

export type InvitationLean = InvitationDoc;

export interface UpsertInvitationInput {
  productId: string;
  workspaceId: string;
  email: string;
  roleId: string;
  roleSlug: string;
  invitedBy: string;
  tokenHash: string;
  isExistingUser: boolean;
  expiresAt: Date;
}

/**
 * Re-use a PENDING row for the same (workspaceId, email) when present;
 * else insert a fresh one. Resending an invitation just bumps the token +
 * timestamps + counter atomically.
 */
export async function upsertPendingInvitation(
  input: UpsertInvitationInput,
): Promise<InvitationLean> {
  const now = new Date();
  const filter = { workspaceId: input.workspaceId, email: input.email, status: 'PENDING' };
  const updated = await Invitation.findOneAndUpdate(
    filter,
    {
      $set: {
        productId: input.productId,
        roleId: input.roleId,
        roleSlug: input.roleSlug,
        invitedBy: input.invitedBy,
        tokenHash: input.tokenHash,
        isExistingUser: input.isExistingUser,
        expiresAt: input.expiresAt,
        lastSentAt: now,
      },
      $inc: { resendCount: 1 },
      $setOnInsert: { status: 'PENDING' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<InvitationLean | null>();
  if (!updated) throw new Error('upsertPendingInvitation returned null');
  return updated;
}

export async function findByTokenHash(tokenHash: string): Promise<InvitationLean | null> {
  return Invitation.findOne({ tokenHash }).lean<InvitationLean | null>();
}

export async function findById(invId: string): Promise<InvitationLean | null> {
  return Invitation.findById(invId).lean<InvitationLean | null>();
}

export async function listForWorkspace(
  productId: string,
  workspaceId: string,
): Promise<InvitationLean[]> {
  return Invitation.find({ productId, workspaceId, status: 'PENDING' })
    .sort({ createdAt: -1 })
    .lean<InvitationLean[]>();
}

export async function markAccepted(
  invId: string,
  acceptedByUserId: string,
): Promise<boolean> {
  const res = await Invitation.updateOne(
    { _id: invId, status: 'PENDING' },
    { $set: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId } },
  );
  return res.modifiedCount === 1;
}

export async function markRevoked(invId: string, revokedBy: string): Promise<boolean> {
  const res = await Invitation.updateOne(
    { _id: invId, status: 'PENDING' },
    { $set: { status: 'REVOKED', revokedAt: new Date(), revokedBy } },
  );
  return res.modifiedCount === 1;
}

export async function revokePendingForWorkspace(
  workspaceId: string,
  revokedBy: string,
): Promise<number> {
  const res = await Invitation.updateMany(
    { workspaceId, status: 'PENDING' },
    { $set: { status: 'REVOKED', revokedAt: new Date(), revokedBy } },
  );
  return res.modifiedCount;
}
