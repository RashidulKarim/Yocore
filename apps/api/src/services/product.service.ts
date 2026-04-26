/**
 * Product service — Phase 3.3 (Flow B / AJ).
 *
 * SUPER_ADMIN-only management of registered Yo products. The handler layer
 * MUST gate every call with `requireSuperAdmin(req)` — this service trusts
 * its caller has been authorised.
 *
 * Secret strategy:
 *  - `apiKey`     → public, plaintext, format `yc_live_pk_<base64url>`
 *  - `apiSecret`  → returned ONCE on create / rotate; stored as Argon2id hash
 *                   (same primitive used by `middleware/api-key.ts` for verify).
 *  - `webhookSecret` → 64 hex chars; stored plaintext (used to HMAC-sign
 *                   outbound webhooks; must be readable to sign).
 *  - Webhook secret rotation keeps the prior secret valid for 24h so product
 *                   verifiers can dual-verify during the cutover (Flow AJ).
 */
import { randomBytes } from 'node:crypto';
import { hash as hashSecret } from '../lib/password.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import * as productRepo from '../repos/product.repo.js';
import * as roleRepo from '../repos/role.repo.js';
import type {
  CreateProductRequest,
  CreateProductResponse,
  ProductSummary,
  RotateApiSecretResponse,
  RotateWebhookSecretResponse,
  UpdateBillingConfigRequest,
  UpdateProductRequest,
  UpdateProductStatusRequest,
} from '@yocore/types';

export interface CreateProductServiceOptions {
  /** How long the previous webhook secret remains valid after rotation. */
  webhookSecretGraceMs?: number;
}

export interface ProductService {
  create(input: CreateProductRequest, actorUserId: string): Promise<CreateProductResponse>;
  list(): Promise<ProductSummary[]>;
  get(productId: string): Promise<productRepo.ProductLean>;
  update(productId: string, input: UpdateProductRequest): Promise<ProductSummary>;
  setStatus(productId: string, input: UpdateProductStatusRequest): Promise<ProductSummary>;
  rotateApiSecret(productId: string): Promise<RotateApiSecretResponse>;
  rotateWebhookSecret(productId: string): Promise<RotateWebhookSecretResponse>;
  updateBillingConfig(
    productId: string,
    input: UpdateBillingConfigRequest,
  ): Promise<productRepo.ProductLean>;
}

const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

function generateApiKey(): string {
  return `yc_live_pk_${randomBytes(24).toString('base64url')}`;
}

function generateApiSecret(): string {
  return randomBytes(32).toString('base64url');
}

function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function toSummary(p: productRepo.ProductLean): ProductSummary {
  return {
    id: p._id,
    name: p.name,
    slug: p.slug,
    status: p.status as ProductSummary['status'],
    apiKey: p.apiKey,
    billingScope: p.billingScope as ProductSummary['billingScope'],
    webhookUrl: p.webhookUrl ?? null,
    createdAt: (p as { createdAt?: Date }).createdAt?.toISOString() ?? new Date(0).toISOString(),
  };
}

export function createProductService(opts: CreateProductServiceOptions = {}): ProductService {
  const graceMs = opts.webhookSecretGraceMs ?? DEFAULT_GRACE_MS;

  async function loadOr404(productId: string): Promise<productRepo.ProductLean> {
    const p = await productRepo.findProductById(productId);
    if (!p) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
    return p;
  }

  return {
    async create(input, actorUserId) {
      const slug = input.slug.trim().toLowerCase();
      const existing = await productRepo.findProductBySlug(slug);
      if (existing) {
        throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Slug already in use', {
          field: 'slug',
        });
      }

      const apiKey = generateApiKey();
      const apiSecret = generateApiSecret();
      const apiSecretHash = await hashSecret(apiSecret);
      const webhookSecret = generateWebhookSecret();

      const created = await productRepo.createProduct({
        name: input.name,
        slug,
        apiKey,
        apiSecretHash,
        webhookSecret,
        domain: input.domain ?? null,
        description: input.description ?? null,
        logoUrl: input.logoUrl ?? null,
        allowedOrigins: input.allowedOrigins ?? [],
        allowedRedirectUris: input.allowedRedirectUris ?? [],
        billingScope: input.billingScope,
        ...(input.billingConfig ? { billingConfig: input.billingConfig } : {}),
        webhookUrl: input.webhookUrl ?? null,
        webhookEvents: input.webhookEvents ?? [],
        createdBy: actorUserId,
      });

      // Seed the four platform roles so the product can immediately accept
      // memberships (Flow Z/L). Idempotent — never overwrites admin edits.
      await roleRepo.ensurePlatformRoles(created._id);

      return {
        product: toSummary(created),
        apiSecret,
        webhookSecret,
      };
    },

    async list() {
      const all = await productRepo.listProducts();
      return all.map(toSummary);
    },

    async get(productId) {
      return loadOr404(productId);
    },

    async update(productId, input) {
      await loadOr404(productId);
      const updated = await productRepo.updateProductProfile(productId, input);
      if (!updated) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      return toSummary(updated);
    },

    async setStatus(productId, input) {
      await loadOr404(productId);
      const updated = await productRepo.setProductStatus(productId, input.status);
      if (!updated) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      return toSummary(updated);
    },

    async rotateApiSecret(productId) {
      await loadOr404(productId);
      const newSecret = generateApiSecret();
      const newHash = await hashSecret(newSecret);
      const updated = await productRepo.setApiSecretHash(productId, newHash);
      if (!updated) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      return {
        apiSecret: newSecret,
        rotatedAt: (updated.apiSecretRotatedAt ?? new Date()).toISOString(),
      };
    },

    async rotateWebhookSecret(productId) {
      await loadOr404(productId);
      const newSecret = generateWebhookSecret();
      const result = await productRepo.rotateWebhookSecret(productId, newSecret, graceMs);
      if (!result) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      return {
        webhookSecret: newSecret,
        rotatedAt: new Date().toISOString(),
        previousSecretExpiresAt:
          result.previousSecretExpiresAt?.toISOString() ?? new Date().toISOString(),
      };
    },

    async updateBillingConfig(productId, input) {
      await loadOr404(productId);
      const updated = await productRepo.updateBillingConfig(productId, input);
      if (!updated) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      return updated;
    },
  };
}
