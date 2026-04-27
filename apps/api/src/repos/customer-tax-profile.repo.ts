/**
 * Customer Tax Profile repository — `customerTaxProfiles` collection (YC-005).
 *
 * One profile per (userId, productId) for self-billed accounts, OR per
 * (workspaceId, productId) for workspace-billed accounts. The model's partial
 * unique indexes enforce non-overlap.
 */
import {
  CustomerTaxProfile,
  type CustomerTaxProfileDoc,
} from '../db/models/CustomerTaxProfile.js';

export type TaxProfileLean = CustomerTaxProfileDoc;

export interface UpsertTaxProfileInput {
  productId: string;
  userId: string;
  workspaceId?: string | null;
  taxIdType: string;
  taxIdValue: string;
  billingName?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingPostalCode?: string | null;
  billingState?: string | null;
  billingCountry?: string | null;
}

export async function upsertTaxProfile(
  input: UpsertTaxProfileInput,
): Promise<TaxProfileLean> {
  const filter: Record<string, unknown> = {
    productId: input.productId,
    userId: input.userId,
  };
  if (input.workspaceId) filter['workspaceId'] = input.workspaceId;
  else filter['workspaceId'] = { $exists: false };

  const doc = await CustomerTaxProfile.findOneAndUpdate(
    filter,
    {
      $set: {
        productId: input.productId,
        userId: input.userId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        taxIdType: input.taxIdType,
        taxIdValue: input.taxIdValue,
        verificationStatus: 'unverified',
        billingName: input.billingName ?? null,
        billingAddressLine1: input.billingAddressLine1 ?? null,
        billingAddressLine2: input.billingAddressLine2 ?? null,
        billingCity: input.billingCity ?? null,
        billingPostalCode: input.billingPostalCode ?? null,
        billingState: input.billingState ?? null,
        billingCountry: input.billingCountry ?? null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<TaxProfileLean | null>();
  if (!doc) throw new Error('upsertTaxProfile returned null');
  return doc;
}

export async function findForSubject(args: {
  productId: string;
  userId: string;
  workspaceId?: string | null;
}): Promise<TaxProfileLean | null> {
  const filter: Record<string, unknown> = {
    productId: args.productId,
    userId: args.userId,
  };
  if (args.workspaceId) filter['workspaceId'] = args.workspaceId;
  else filter['workspaceId'] = { $exists: false };
  return CustomerTaxProfile.findOne(filter).lean<TaxProfileLean | null>();
}

export async function deleteProfile(
  productId: string,
  profileId: string,
): Promise<boolean> {
  const res = await CustomerTaxProfile.deleteOne({ productId, _id: profileId });
  return (res.deletedCount ?? 0) > 0;
}
