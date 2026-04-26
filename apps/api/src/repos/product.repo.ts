/**
 * Product repository — `products` collection.
 *
 * Products are global (no productId scoping — they ARE the tenants). All other
 * repos must scope by productId; this is one of the small set of exceptions
 * (see ADR-001 + .github/copilot-instructions.md §3).
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
