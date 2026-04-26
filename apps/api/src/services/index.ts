/**
 * Service layer barrel + base pattern docs.
 *
 * RULES (see .github/copilot-instructions.md §2):
 *   - Services hold business logic. NEVER import express. NEVER touch Mongoose
 *     directly — go through repos.
 *   - Services may call other services + multiple repos.
 *   - Services throw `AppError` (with the most specific ErrorCode) on any
 *     failure that should map to a 4xx/5xx response.
 *   - Side effects (audit log, outbound webhook, email) emit through dedicated
 *     services; never inline.
 *   - Pass `clock.now()` through an injected helper rather than `Date.now()`
 *     for testability.
 *
 * Phase 3 modules will be added here as they're implemented:
 *   export * as authService from './auth.service.js';
 *   export * as billingService from './billing.service.js';
 *   ...
 */
export {};
