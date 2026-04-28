/**
 * WorkspaceMember repository — `workspaceMembers` collection.
 *
 * Multi-tenant: every query filters by `productId` (FIX-MT / ADR-001).
 */
import {
  WorkspaceMember,
  type WorkspaceMemberDoc,
} from '../db/models/WorkspaceMember.js';

export type WorkspaceMemberLean = WorkspaceMemberDoc;

export interface CreateMemberInput {
  workspaceId: string;
  productId: string;
  userId: string;
  roleId: string;
  roleSlug: string;
  addedBy?: string | null;
}

export async function createMember(input: CreateMemberInput): Promise<WorkspaceMemberLean> {
  const doc = await WorkspaceMember.create({
    workspaceId: input.workspaceId,
    productId: input.productId,
    userId: input.userId,
    roleId: input.roleId,
    roleSlug: input.roleSlug,
    addedBy: input.addedBy ?? null,
    status: 'ACTIVE',
  });
  return doc.toObject() as WorkspaceMemberLean;
}

/** Idempotent — returns existing membership if present. */
export async function upsertMember(
  input: CreateMemberInput,
): Promise<WorkspaceMemberLean> {
  const now = new Date();
  const updated = await WorkspaceMember.findOneAndUpdate(
    { workspaceId: input.workspaceId, userId: input.userId },
    {
      $setOnInsert: {
        workspaceId: input.workspaceId,
        productId: input.productId,
        userId: input.userId,
        roleId: input.roleId,
        roleSlug: input.roleSlug,
        addedBy: input.addedBy ?? null,
        status: 'ACTIVE',
        joinedAt: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<WorkspaceMemberLean | null>();
  if (!updated) throw new Error('upsertMember returned null');
  return updated;
}

export async function findMember(
  productId: string,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberLean | null> {
  return WorkspaceMember.findOne({
    productId,
    workspaceId,
    userId,
  }).lean<WorkspaceMemberLean | null>();
}

export async function listForWorkspace(
  productId: string,
  workspaceId: string,
): Promise<WorkspaceMemberLean[]> {
  return WorkspaceMember.find({ productId, workspaceId, status: 'ACTIVE' })
    .sort({ joinedAt: 1 })
    .lean<WorkspaceMemberLean[]>();
}

export async function listForUser(
  productId: string,
  userId: string,
): Promise<WorkspaceMemberLean[]> {
  return WorkspaceMember.find({ productId, userId, status: 'ACTIVE' })
    .sort({ joinedAt: 1 })
    .lean<WorkspaceMemberLean[]>();
}

export async function countActive(
  productId: string,
  workspaceId: string,
): Promise<number> {
  return WorkspaceMember.countDocuments({ productId, workspaceId, status: 'ACTIVE' });
}

export async function setRole(
  productId: string,
  workspaceId: string,
  userId: string,
  roleId: string,
  roleSlug: string,
): Promise<WorkspaceMemberLean | null> {
  return WorkspaceMember.findOneAndUpdate(
    { productId, workspaceId, userId, status: 'ACTIVE' },
    { $set: { roleId, roleSlug } },
    { new: true },
  ).lean<WorkspaceMemberLean | null>();
}

export async function removeMember(
  productId: string,
  workspaceId: string,
  userId: string,
  removedBy: string,
): Promise<boolean> {
  const res = await WorkspaceMember.updateOne(
    { productId, workspaceId, userId, status: 'ACTIVE' },
    { $set: { status: 'REMOVED', removedAt: new Date(), removedBy } },
  );
  return res.modifiedCount === 1;
}

/**
 * V1.2-A — count active members in a product carrying a given roleId.
 * Used as a delete-guard before removing a custom role.
 */
export async function countActiveByRole(
  productId: string,
  roleId: string,
): Promise<number> {
  return WorkspaceMember.countDocuments({ productId, roleId, status: 'ACTIVE' });
}
