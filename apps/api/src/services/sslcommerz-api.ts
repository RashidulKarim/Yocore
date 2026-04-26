/**
 * SSLCommerz gateway adapter — Phase 3.4 Wave 3 (Flow J4 / ADR-005).
 *
 * Bundles every external HTTP call needed for the SSLCommerz checkout flow:
 *
 *   1. Stripe `customers.create` + `subscriptions.create` w/ `collection_method:
 *      "send_invoice"` and `days_until_due:1` — used as a billing CALENDAR
 *      only (Stripe tracks period math, never auto-charges).
 *   2. SSLCommerz `POST /gwprocess/v4/api.php` — creates the hosted checkout
 *      session for the first invoice; returns `GatewayPageURL` we redirect
 *      the user to.
 *   3. SSLCommerz `validator/api/validationserverAPI.php` — Order Validation
 *      probe used by the IPN handler to double-check `val_id` after the
 *      signature passes.
 *   4. Stripe `invoices.pay({paid_out_of_band:true})` — once SSLCommerz
 *      collects the payment we mark the matching Stripe invoice paid so
 *      Stripe schedules the next invoice (loop closes).
 *
 * Every external call is wrapped in opossum (`createBreaker`) at call sites
 * via the `CheckoutService` / `SslcommerzWebhookService` (we keep the API
 * surface narrow + stub-friendly here).
 */
import { AppError, ErrorCode } from '../lib/errors.js';

const STRIPE_BASE = 'https://api.stripe.com/v1';

// ── Stripe shapes (subset) ──────────────────────────────────────────────
export interface StripeCalendarSubscription {
  id: string;
  customer: string;
  latest_invoice: string;
  current_period_start: number | null;
  current_period_end: number | null;
}

// ── SSLCommerz shapes (subset) ──────────────────────────────────────────
export interface SslcommerzSessionResult {
  status: 'SUCCESS' | 'FAILED';
  failedreason?: string | null;
  GatewayPageURL: string;
  sessionkey?: string | null;
}

export interface SslcommerzValidationResult {
  status: string; // "VALID" | "VALIDATED" | "INVALID_TRANSACTION" | "FAILED"
  tran_id?: string | null;
  val_id?: string | null;
  amount?: string | null;
  currency?: string | null;
  store_amount?: string | null;
  bank_tran_id?: string | null;
  card_type?: string | null;
}

// ── Adapter interface (injectable for tests) ────────────────────────────
export interface SslcommerzGatewayApi {
  /** Create or fetch a Stripe customer for the calendar subscription. */
  findOrCreateStripeCalendarCustomer(args: {
    secretKey: string;
    yocoreUserId: string;
    yocoreProductId: string;
    email: string | null;
    name?: string | null;
  }): Promise<{ id: string }>;

  /** Create the Stripe calendar subscription (`collection_method:"send_invoice"`). */
  createStripeCalendarSubscription(args: {
    secretKey: string;
    customerId: string;
    priceId: string;
    quantity: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeCalendarSubscription>;

  /** Create a SSLCommerz hosted-checkout session. */
  createSslcommerzSession(args: {
    storeId: string;
    storePasswd: string;
    sandbox: boolean;
    tranId: string;
    totalAmount: number; // BDT minor units? SSLCommerz expects MAJOR units.
    currency: string;    // 'BDT'
    successUrl: string;
    failUrl: string;
    cancelUrl: string;
    ipnUrl: string;
    cusName: string;
    cusEmail: string;
  }): Promise<SslcommerzSessionResult>;

  /** Order Validation probe — used by IPN handler. */
  validateSslcommerzTransaction(args: {
    storeId: string;
    storePasswd: string;
    sandbox: boolean;
    valId: string;
  }): Promise<SslcommerzValidationResult>;

  /** Mark a Stripe invoice paid out-of-band (closes the loop). */
  payStripeInvoiceOutOfBand(args: {
    secretKey: string;
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string }>;
}

// ── Default fetch-based implementation ─────────────────────────────────

function form(values: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    u.set(k, String(v));
  }
  return u.toString();
}

async function stripePost(
  path: string,
  secretKey: string,
  body: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-06-20',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_BASE}${path}`, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      `Stripe ${path} failed`,
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  return res.json();
}

const sslcommerzBase = (sandbox: boolean): string =>
  sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com';

export const defaultSslcommerzApi: SslcommerzGatewayApi = {
  async findOrCreateStripeCalendarCustomer({ secretKey, yocoreUserId, yocoreProductId, email, name }) {
    // Stripe customer.search by metadata.
    const url = new URL(`${STRIPE_BASE}/customers/search`);
    url.searchParams.set('query', `metadata['yocoreUserId']:'${yocoreUserId}'`);
    url.searchParams.set('limit', '1');
    const sres = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    });
    if (sres.ok) {
      const j = (await sres.json()) as { data?: Array<{ id: string }> };
      const found = j.data?.[0]?.id;
      if (found) return { id: found };
    }
    const body = form({
      email: email ?? undefined,
      name: name ?? undefined,
      'metadata[yocoreUserId]': yocoreUserId,
      'metadata[yocoreProductId]': yocoreProductId,
    });
    const j = (await stripePost(
      '/customers',
      secretKey,
      body,
      `yocore:cust:${yocoreProductId}:${yocoreUserId}`,
    )) as { id: string };
    return { id: j.id };
  },

  async createStripeCalendarSubscription({
    secretKey,
    customerId,
    priceId,
    quantity,
    metadata,
    idempotencyKey,
  }) {
    const body = new URLSearchParams();
    body.set('customer', customerId);
    body.set('items[0][price]', priceId);
    body.set('items[0][quantity]', String(quantity));
    body.set('collection_method', 'send_invoice');
    body.set('days_until_due', '1');
    for (const [k, v] of Object.entries(metadata)) {
      body.set(`metadata[${k}]`, v);
    }
    const j = (await stripePost(
      '/subscriptions',
      secretKey,
      body.toString(),
      idempotencyKey,
    )) as {
      id: string;
      customer: string;
      latest_invoice: { id: string } | string;
      current_period_start: number | null;
      current_period_end: number | null;
    };
    const latest = typeof j.latest_invoice === 'string' ? j.latest_invoice : j.latest_invoice.id;
    return {
      id: j.id,
      customer: j.customer,
      latest_invoice: latest,
      current_period_start: j.current_period_start,
      current_period_end: j.current_period_end,
    };
  },

  async createSslcommerzSession(args) {
    const url = `${sslcommerzBase(args.sandbox)}/gwprocess/v4/api.php`;
    const body = form({
      store_id: args.storeId,
      store_passwd: args.storePasswd,
      total_amount: args.totalAmount,
      currency: args.currency,
      tran_id: args.tranId,
      success_url: args.successUrl,
      fail_url: args.failUrl,
      cancel_url: args.cancelUrl,
      ipn_url: args.ipnUrl,
      cus_name: args.cusName,
      cus_email: args.cusEmail,
      shipping_method: 'NO',
      product_name: 'Subscription',
      product_category: 'Subscription',
      product_profile: 'general',
      cus_add1: 'N/A',
      cus_city: 'N/A',
      cus_country: 'BD',
      cus_phone: '0000000000',
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'SSLCommerz session create failed',
        { status: res.status },
      );
    }
    const j = (await res.json()) as SslcommerzSessionResult;
    if (j.status !== 'SUCCESS' || !j.GatewayPageURL) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        `SSLCommerz session not SUCCESS: ${j.failedreason ?? 'unknown'}`,
      );
    }
    return j;
  },

  async validateSslcommerzTransaction({ storeId, storePasswd, sandbox, valId }) {
    const url = new URL(`${sslcommerzBase(sandbox)}/validator/api/validationserverAPI.php`);
    url.searchParams.set('val_id', valId);
    url.searchParams.set('store_id', storeId);
    url.searchParams.set('store_passwd', storePasswd);
    url.searchParams.set('format', 'json');
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'SSLCommerz validation API failed',
        { status: res.status },
      );
    }
    return (await res.json()) as SslcommerzValidationResult;
  },

  async payStripeInvoiceOutOfBand({ secretKey, invoiceId, idempotencyKey }) {
    const j = (await stripePost(
      `/invoices/${invoiceId}/pay`,
      secretKey,
      form({ paid_out_of_band: 'true' }),
      idempotencyKey,
    )) as { id: string; status: string };
    return j;
  },
};
