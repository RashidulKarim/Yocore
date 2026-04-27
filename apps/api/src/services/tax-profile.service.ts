/**
 * Tax profile service — Phase 3.4 Wave 13 (YC-005).
 *
 * Lets a user (or workspace OWNER/ADMIN) maintain a tax id + billing
 * address that flows into Stripe customer + future invoice rendering.
 * Stripe Tax ID sync is intentionally out of scope for v1.0 — verification
 * is reserved for `verificationStatus: 'unverified'` until a back-office
 * verifier flips it.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as taxProfileRepo from '../repos/customer-tax-profile.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import type { UpsertTaxProfileRequest, TaxProfile } from '@yocore/types';

export interface TaxProfileContext {
  userId: string;
  productId: string;
}

export interface TaxProfileService {
  upsert(actor: TaxProfileContext, input: UpsertTaxProfileRequest): Promise<TaxProfile>;
  get(
    actor: TaxProfileContext,
    workspaceId?: string,
  ): Promise<TaxProfile | null>;
}

function toDto(p: taxProfileRepo.TaxProfileLean): TaxProfile {
  return {
    id: p._id,
    productId: p.productId,
    userId: p.userId,
    workspaceId: p.workspaceId ?? null,
    taxIdType: p.taxIdType,
    taxIdValue: p.taxIdValue,
    verificationStatus: (p.verificationStatus ?? 'unverified') as TaxProfile['verificationStatus'],
    billingName: p.billingName ?? null,
    billingAddressLine1: p.billingAddressLine1 ?? null,
    billingAddressLine2: p.billingAddressLine2 ?? null,
    billingCity: p.billingCity ?? null,
    billingPostalCode: p.billingPostalCode ?? null,
    billingState: p.billingState ?? null,
    billingCountry: p.billingCountry ?? null,
  };
}

export function createTaxProfileService(): TaxProfileService {
  async function authorize(actor: TaxProfileContext, workspaceId?: string): Promise<void> {
    if (!workspaceId) return; // user-scoped — already authenticated
    const member = await memberRepo.findMember(actor.productId, workspaceId, actor.userId);
    if (!member || member.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a workspace member');
    }
    if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'OWNER or ADMIN required');
    }
  }

  return {
    async upsert(actor, input) {
      const product = await productRepo.findProductById(actor.productId);
      if (!product || product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found or inactive');
      }
      // Workspace-scope only when product is workspace-billed.
      if (input.workspaceId && product.billingScope !== 'workspace') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'workspaceId may only be set on workspace-scoped products',
          { field: 'workspaceId' },
        );
      }
      await authorize(actor, input.workspaceId);

      // Defensive: tax id length sanity. Real per-country validators land
      // alongside Stripe Tax ID sync in a later phase.
      if (input.taxIdValue.trim().length < 2) {
        throw new AppError(ErrorCode.BILLING_TAX_ID_INVALID, 'Tax id is too short');
      }

      const saved = await taxProfileRepo.upsertTaxProfile({
        productId: actor.productId,
        userId: actor.userId,
        workspaceId: input.workspaceId ?? null,
        taxIdType: input.taxIdType,
        taxIdValue: input.taxIdValue.trim(),
        billingName: input.billingName ?? null,
        billingAddressLine1: input.billingAddressLine1 ?? null,
        billingAddressLine2: input.billingAddressLine2 ?? null,
        billingCity: input.billingCity ?? null,
        billingPostalCode: input.billingPostalCode ?? null,
        billingState: input.billingState ?? null,
        billingCountry: input.billingCountry ?? null,
      });
      return toDto(saved);
    },

    async get(actor, workspaceId) {
      const product = await productRepo.findProductById(actor.productId);
      if (!product) {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      }
      await authorize(actor, workspaceId);
      const found = await taxProfileRepo.findForSubject({
        productId: actor.productId,
        userId: actor.userId,
        workspaceId: workspaceId ?? null,
      });
      return found ? toDto(found) : null;
    },
  };
}
