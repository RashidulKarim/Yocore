/**
 * Product repository — `products` collection.
 *
 * Products are global tenants (no productId scoping — they ARE the tenants).
 * All other repos must scope by productId. See ADR-001 §3.
 *
 * Owned by Phase 3.3 (Flow B / AJ).
 */
import { Product, type ProductDoc } from '../db/models/Product.js';

export type ProductLean = ProductDoc;

export async function findProductBySlug(slug: string): Promise<ProductLean | null> {
  const normalized = slug.trim().toLowerCase();
  return Product.findOne({ slug: normalized }).lean<ProductLean | null>();
}

export async function findProductById(productId: string): Promise<ProductLean | null> {
  return Product.findById(productId).lean<ProductLean | null>();
}

export async function findProductByApiKey(apiKey: string): Promise<ProductLean | null> {
  return Product.findOne({ apiKey }).lean<ProductLean | null>();
}

export async function listProducts(): Promise<ProductLean[]> {
  return Product.find({}).sort({ createdAt: -1 }).lean<ProductLean[]>();
}

export interface CreateProductInput {
  name: string;
  slug: string;
  apiKey: string;
  apiSecretHash: string;
  webhookSecret: string;
  domain?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  allowedOrigins?: string[];
  allowedRedirectUris?: string[];
  billingScope: 'user' | 'workspace';
  billingConfig?: Record<string, unknown>;
  webhookUrl?: string | null;
  webhookEvents?: string[];
  createdBy?: string | null;
}

/** Insert a new product row (status defaults to INACTIVE). */
export async function createProduct(input: CreateProductInput): Promise<ProductLean> {
  const doc = await Product.create({
    name: input.name,
    slug: input.slug,
    apiKey: input.apiKey,
    apiSecretHash: input.apiSecretHash,
    webhookSecret: input.webhookSecret,
    domain: input.domain ?? null,
    description: input.description ?? null,
    logoUrl: input.logoUrl ?? null,
    allowedOrigins: input.allowedOrigins ?? [],
    allowedRedirectUris: input.allowedRedirectUris ?? [],
    billingScope: input.billingScope,
    ...(input.billingConfig ? { billingConfig: input.billingConfig } : {}),
    webhookUrl: input.webhookUrl ?? null,
    webhookEvents: input.webhookEvents ?? [],
    createdBy: input.createdBy ?? null,
  });
  return doc.toObject() as ProductLean;
}

export interface UpdateProductProfileInput {
  name?: string;
  domain?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  allowedOrigins?: string[];
  allowedRedirectUris?: string[];
  webhookUrl?: string | null;
  webhookEvents?: string[];
}

export async function updateProductProfile(
  productId: string,
  patch: UpdateProductProfileInput,
): Promise<ProductLean | null> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[k] = v;
  }
  if (Object.keys(set).length === 0) return findProductById(productId);
  return Product.findByIdAndUpdate(productId, { $set: set }, { new: true }).lean<ProductLean | null>();
}

export async function setProductStatus(
  productId: string,
  status: 'INACTIVE' | 'ACTIVE' | 'MAINTENANCE' | 'ABANDONED',
): Promise<ProductLean | null> {
  const set: Record<string, unknown> = { status };
  if (status === 'ABANDONED') set['abandonedAt'] = new Date();
  return Product.findByIdAndUpdate(productId, { $set: set }, { new: true }).lean<ProductLean | null>();
}

export async function setApiSecretHash(
  productId: string,
  apiSecretHash: string,
): Promise<ProductLean | null> {
  const now = new Date();
  return Product.findByIdAndUpdate(
    productId,
    {
      $set: {
        apiSecretHash,
        apiSecretRotatedAt: now,
      },
    },
    { new: true },
  ).lean<ProductLean | null>();
}

/**
 * Atomically rotate the webhook signing secret with a 24h grace window.
 *
 * Moves the current `webhookSecret` into `webhookSecretPrevious.{secret,
 * deprecatedAt, expiresAt}` and installs the new secret as active. Outbound
 * webhooks are signed with the new secret immediately; products MUST verify
 * against both during the grace window.
 */
export async function rotateWebhookSecret(
  productId: string,
  newSecret: string,
  graceMs: number,
): Promise<{ product: ProductLean; previousSecretExpiresAt: Date | null } | null> {
  const current = await Product.findById(productId).lean<ProductLean | null>();
  if (!current) return null;
  const now = new Date();
  const hadPrevious = !!current.webhookSecret;
  const expiresAt = hadPrevious ? new Date(now.getTime() + graceMs) : null;
  const updated = await Product.findByIdAndUpdate(
    productId,
    {
      $set: {
        webhookSecret: newSecret,
        'webhookSecretPrevious.secret': hadPrevious ? current.webhookSecret : null,
        'webhookSecretPrevious.deprecatedAt': hadPrevious ? now : null,
        'webhookSecretPrevious.expiresAt': expiresAt,
      },
    },
    { new: true },
  ).lean<ProductLean | null>();
  if (!updated) return null;
  return { product: updated, previousSecretExpiresAt: expiresAt };
}

export async function clearExpiredPreviousWebhookSecrets(now = new Date()): Promise<number> {
  const res = await Product.updateMany(
    { 'webhookSecretPrevious.expiresAt': { $ne: null, $lt: now } },
    {
      $set: {
        'webhookSecretPrevious.secret': null,
        'webhookSecretPrevious.deprecatedAt': null,
        'webhookSecretPrevious.expiresAt': null,
      },
    },
  );
  return res.modifiedCount ?? 0;
}

export async function updateBillingConfig(
  productId: string,
  patch: Record<string, unknown>,
): Promise<ProductLean | null> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) set[`billingConfig.${k}`] = v;
  }
  if (Object.keys(set).length === 0) return findProductById(productId);
  return Product.findByIdAndUpdate(productId, { $set: set }, { new: true }).lean<ProductLean | null>();
}
