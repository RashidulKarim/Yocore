/**
 * Server-side YoCore SDK. Auths via API key + secret (Basic).
 * Designed for product backends and platform admin scripts.
 */
import { HttpClient } from './http.js';

export interface YoCoreServerOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** Optional product slug pin; otherwise sent per-call when relevant. */
  productSlug?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export class YoCoreServer {
  private readonly http: HttpClient;

  constructor(opts: YoCoreServerOptions) {
    if (!opts.apiKey || !opts.apiSecret) {
      throw new Error('YoCoreServer: apiKey and apiSecret are required');
    }
    const basic =
      'Basic ' +
      Buffer.from(`${opts.apiKey}:${opts.apiSecret}`, 'utf8').toString('base64');
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      authHeader: () => basic,
      ...(opts.productSlug !== undefined ? { productSlug: opts.productSlug } : {}),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
    });
  }

  // ── Plans / public catalog ──────────────────────────────────────────
  listPlans(productSlug: string) {
    return this.http.request<unknown>({
      method: 'GET',
      path: `/v1/products/${encodeURIComponent(productSlug)}/plans`,
    });
  }

  // ── Subscriptions ──────────────────────────────────────────────────
  getSubscription(productId: string, id: string) {
    return this.http.request<unknown>({
      method: 'GET',
      path: `/v1/products/${productId}/subscriptions/${id}`,
    });
  }

  changePlan(
    productId: string,
    id: string,
    body: { newPlanId: string; quantity?: number },
    idempotencyKey: string,
  ) {
    return this.http.request<unknown>({
      method: 'POST',
      path: `/v1/products/${productId}/subscriptions/${id}/change-plan`,
      body,
      idempotencyKey,
    });
  }

  cancelSubscription(
    productId: string,
    id: string,
    body: { atPeriodEnd: boolean; reason?: string },
    idempotencyKey: string,
  ) {
    return this.http.request<unknown>({
      method: 'POST',
      path: `/v1/products/${productId}/subscriptions/${id}/cancel`,
      body,
      idempotencyKey,
    });
  }

  // ── Workspaces ─────────────────────────────────────────────────────
  listWorkspaces(productId: string) {
    return this.http.request<unknown>({
      method: 'GET',
      path: `/v1/products/${productId}/workspaces`,
    });
  }

  // ── Webhook delivery (admin) ───────────────────────────────────────
  retryWebhookDelivery(deliveryId: string) {
    return this.http.request<unknown>({
      method: 'POST',
      path: `/v1/admin/webhook-deliveries/${deliveryId}/retry`,
    });
  }

  // ── Generic escape hatch ───────────────────────────────────────────
  request<T = unknown>(opts: Parameters<HttpClient['request']>[0]) {
    return this.http.request<T>(opts);
  }
}
