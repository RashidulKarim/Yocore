/**
 * @yocore/sdk — public typed client for the YoCore platform.
 *
 * Two flavors:
 *   - `YoCoreServer` (server-side; auths via `apiKey:apiSecret`)
 *   - `YoCoreClient` (browser/PKCE; auths via end-user JWT)
 *
 * Plus utilities:
 *   - `verifyWebhookSignature(...)` — timing-safe HMAC-SHA256 over raw body
 *   - `retry(fn, opts)`             — exponential backoff w/ Retry-After awareness
 */
export * from './server.js';
export * from './client.js';
export * from './verify-webhook.js';
export * from './retry.js';
export * from './errors.js';
