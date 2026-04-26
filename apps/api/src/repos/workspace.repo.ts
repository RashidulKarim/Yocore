/**
 * Workspace repository — `workspaces` collection.
 *
 * All queries are multi-tenant: filtered by `productId` (FIX-MT / ADR-001).
 */
import { Workspace, type WorkspaceDoc } from '../db/models/Workspace.js';

export type WorkspaceLean = WorkspaceDoc;

export interface CreateWorkspaceInput {
  productId: string;
  name: string;
  slug: string;
  ownerUserId: string;
  /** Defaults to ownerUserId when omitted. */
  billingContactUserId?: string;
  timezone?: string;
  settings?: Record<string, unknown>;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceLean> {
  const doc = await Workspace.create({
    productId: input.productId,
    name: input.name,
    slug: input.slug,
    ownerUserId: input.ownerUserId,
    billingContactUserId: input.billingContactUserId ?? input.ownerUserId,
    status: 'ACTIVE',
    suspended: false,
    dataDeleted: false,
    timezone: input.timezone ?? 'UTC',
    settings: input.settings ?? {},
  });
  return doc.toObject() as WorkspaceLean;
}

/** True when the (productId, slug) pair is already taken. */
export async function slugExists(productId: string, slug: string): Promise<boolean> {
  const found = await Workspace.exists({ productId, slug });
  return found !== null;
}

export async function findBySlug(
  productId: string,
  slug: string,
): Promise<WorkspaceLean | null> {
  return Workspace.findOne({ productId, slug }).lean<WorkspaceLean | null>();
}

export async function findById(
  productId: string,
  workspaceId: string,
): Promise<WorkspaceLean | null> {
  return Workspace.findOne({ productId, _id: workspaceId }).lean<WorkspaceLean | null>();
}

/** Count workspaces a user owns that have not been hard-deleted (Flow L1). */
export async function countOwnedActive(
  productId: string,
  ownerUserId: string,
): Promise<number> {
  return Workspace.countDocuments({
    productId,
    ownerUserId,
    status: { $ne: 'DELETED' },
  });
}

export async function updateProfile(
  productId: string,
  workspaceId: string,
  patch: { name?: string; timezone?: string; settings?: Record<string, unknown> },
): Promise<WorkspaceLean | null> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set['name'] = patch.name;
  if (patch.timezone !== undefined) set['timezone'] = patch.timezone;
  if (patch.settings !== undefined) set['settings'] = patch.settings;
  if (Object.keys(set).length === 0) return findById(productId, workspaceId);
  return Workspace.findOneAndUpdate(
    { productId, _id: workspaceId },
    { $set: set },
    { new: true },
  ).lean<WorkspaceLean | null>();
}

export async function setOwner(
  productId: string,
  workspaceId: string,
  newOwnerUserId: string,
): Promise<WorkspaceLean | null> {
  return Workspace.findOneAndUpdate(
    { productId, _id: workspaceId },
    {
      $set: {
        ownerUserId: newOwnerUserId,
        billingContactUserId: newOwnerUserId,
        ownershipTransferredAt: new Date(),
      },
    },
    { new: true },
  ).lean<WorkspaceLean | null>();
}

export async function markVoluntaryDeletion(
  productId: string,
  workspaceId: string,
  finalizesAt: Date,
): Promise<WorkspaceLean | null> {
  return Workspace.findOneAndUpdate(
    { productId, _id: workspaceId, status: 'ACTIVE' },
    {
      $set: {
        status: 'DELETED',
        suspended: true,
        suspensionReason: 'voluntary_deletion',
        voluntaryDeletionRequestedAt: new Date(),
        voluntaryDeletionFinalizesAt: finalizesAt,
      },
    },
    { new: true },
  ).lean<WorkspaceLean | null>();
}

export async function restoreVoluntaryDeletion(
  productId: string,
  workspaceId: string,
): Promise<WorkspaceLean | null> {
  return Workspace.findOneAndUpdate(
    {
      productId,
      _id: workspaceId,
      status: 'DELETED',
      suspensionReason: 'voluntary_deletion',
      dataDeleted: false,
    },
    {
      $set: {
        status: 'ACTIVE',
        suspended: false,
        suspensionReason: null,
        voluntaryDeletionRequestedAt: null,
        voluntaryDeletionFinalizesAt: null,
      },
    },
    { new: true },
  ).lean<WorkspaceLean | null>();
}
