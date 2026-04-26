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
