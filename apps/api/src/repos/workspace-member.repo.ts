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
