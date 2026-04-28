/**
 * Role repository — `roles` collection.
 *
 * Multi-tenant: every query is scoped by `productId`.
 *
 * Platform roles (OWNER, ADMIN, MEMBER, VIEWER) are seeded per product
 * either when the product is registered (Flow B) or lazily on first use via
 * `ensurePlatformRoles`.
 */
import { Role, type RoleDoc } from '../db/models/Role.js';
import {
  PLATFORM_ROLES,
  type PlatformRoleDefinition,
} from '@yocore/types';

export type RoleLean = RoleDoc;

export async function findById(productId: string, roleId: string): Promise<RoleLean | null> {
  return Role.findOne({ productId, _id: roleId }).lean<RoleLean | null>();
}

export async function findBySlug(productId: string, slug: string): Promise<RoleLean | null> {
  return Role.findOne({ productId, slug }).lean<RoleLean | null>();
}

export async function listForProduct(productId: string): Promise<RoleLean[]> {
  return Role.find({ productId }).sort({ slug: 1 }).lean<RoleLean[]>();
}

export interface CreateRoleInput {
  productId: string;
  slug: string;
  name: string;
  description?: string | null;
  isPlatform?: boolean;
  isDefault?: boolean;
  permissions: readonly string[];
  inheritsFrom?: string | null;
}

export async function createRole(input: CreateRoleInput): Promise<RoleLean> {
  const doc = await Role.create({
    productId: input.productId,
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    isPlatform: input.isPlatform ?? false,
    isDefault: input.isDefault ?? false,
    permissions: [...input.permissions],
    inheritsFrom: input.inheritsFrom ?? null,
  });
  return doc.toObject() as RoleLean;
}

/**
 * Idempotently ensure the four platform roles exist for a given product.
 * Returns the slug → role map (always populated for OWNER/ADMIN/MEMBER/VIEWER).
 *
 * Safe to call repeatedly: missing rows are inserted via `updateOne` upserts;
 * existing rows are left untouched (we never overwrite admin-edited rows).
 */
export async function ensurePlatformRoles(
  productId: string,
): Promise<Record<PlatformRoleDefinition['slug'], RoleLean>> {
  for (const def of PLATFORM_ROLES) {
    await Role.updateOne(
      { productId, slug: def.slug },
      {
        $setOnInsert: {
          productId,
          slug: def.slug,
          name: def.name,
          description: def.description,
          isPlatform: true,
          isDefault: def.isDefault,
          permissions: [...def.permissions],
          inheritsFrom: null,
        },
      },
      { upsert: true },
    );
  }
  const docs = await Role.find({
    productId,
    slug: { $in: PLATFORM_ROLES.map((r) => r.slug) },
  }).lean<RoleLean[]>();
  const out = {} as Record<PlatformRoleDefinition['slug'], RoleLean>;
  for (const d of docs) {
    out[d.slug as PlatformRoleDefinition['slug']] = d;
  }
  return out;
}

// ── V1.2-A: Custom role mutations ─────────────────────────────────────

export interface UpdateRoleFields {
  name?: string;
  description?: string | null;
  permissions?: readonly string[];
  inheritsFrom?: string | null;
  isDefault?: boolean;
}

/**
 * Update mutable fields on a role row. Returns the updated lean doc, or null
 * if no row matched. Caller is responsible for guarding `isPlatform` (this
 * repo touches whatever it's told to).
 */
export async function updateRole(
  productId: string,
  roleId: string,
  fields: UpdateRoleFields,
): Promise<RoleLean | null> {
  const set: Record<string, unknown> = {};
  if (fields.name !== undefined) set['name'] = fields.name;
  if (fields.description !== undefined) set['description'] = fields.description;
  if (fields.permissions !== undefined) set['permissions'] = [...fields.permissions];
  if (fields.inheritsFrom !== undefined) set['inheritsFrom'] = fields.inheritsFrom;
  if (fields.isDefault !== undefined) set['isDefault'] = fields.isDefault;
  if (Object.keys(set).length === 0) {
    return findById(productId, roleId);
  }
  return Role.findOneAndUpdate(
    { productId, _id: roleId },
    { $set: set },
    { new: true },
  ).lean<RoleLean | null>();
}

export async function deleteRole(productId: string, roleId: string): Promise<boolean> {
  const res = await Role.deleteOne({ productId, _id: roleId });
  return res.deletedCount === 1;
}

