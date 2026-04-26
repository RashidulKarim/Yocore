/**
 * Repository layer barrel + base pattern docs.
 *
 * RULES (see .github/copilot-instructions.md §2):
 *   - Repos are the ONLY layer allowed to import Mongoose models.
 *   - Repos are STATELESS — no instance fields. Export plain async functions.
 *   - Every multi-tenant collection (i.e. every model except User, Bundle,
 *     SuperAdminConfig, JwtSigningKey, jobs) MUST take `productId` as the first
 *     argument and include it in every query (FIX-MT / ADR-001).
 *   - Repos return plain objects (`.lean()`), never Mongoose documents.
 *   - Repos throw `AppError` for not-found / conflict situations OR return null
 *     and let the service decide — pick one convention per repo and document it.
 *
 * Phase 3 modules will be added here as they're implemented:
 *   export * as userRepo from './user.repo.js';
 *   export * as productRepo from './product.repo.js';
 *   ...
 */
export {};
