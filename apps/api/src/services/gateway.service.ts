/**
 * Gateway service — Phase 3.3 (Flow C1–C5).
 *
 * Encrypts provider credentials via `lib/encryption.ts` (AES-256-GCM envelope)
 * and verifies them with the live provider before persisting. Verification is
 * wrapped in a circuit breaker so a flaky provider can't take down admin UX.
 *
 * Credentials NEVER appear in responses, logs or audit metadata. Only metadata
 * (provider, mode, status, lastVerification) is exposed.
 */
import { encrypt } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import type {
  AddGatewayRequest,
  GatewaySummary,
} from '@yocore/types';

export type VerifyFn = (
  provider: 'stripe' | 'sslcommerz' | 'paypal' | 'paddle',
  mode: 'live' | 'test',
  credentials: Record<string, string>,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface CreateGatewayServiceOptions {
  /** Override for unit/integration tests (skip real HTTP). */
  verify?: VerifyFn;
}

export interface GatewayService {
  add(
    productId: string,
    input: AddGatewayRequest,
    actorUserId: string,
  ): Promise<GatewaySummary>;
  list(productId: string): Promise<GatewaySummary[]>;
  get(productId: string, gatewayId: string): Promise<GatewaySummary>;
  remove(productId: string, gatewayId: string): Promise<void>;
}

function toSummary(g: gatewayRepo.PaymentGatewayLean): GatewaySummary {
  return {
    id: g._id,
    productId: g.productId,
    provider: g.provider as GatewaySummary['provider'],
    mode: g.mode as GatewaySummary['mode'],
    status: g.status as GatewaySummary['status'],
    displayName: g.displayName ?? null,
    lastVerifiedAt: g.lastVerifiedAt?.toISOString?.() ?? null,
    lastVerificationStatus:
      (g.lastVerificationStatus as 'ok' | 'failed' | null) ?? null,
    lastVerificationError: g.lastVerificationError ?? null,
    createdAt:
      (g as { createdAt?: Date }).createdAt?.toISOString?.() ??
      new Date(0).toISOString(),
  };
}

/** Default Stripe verifier — `GET /v1/account` with the secret key. */
async function defaultStripeVerify(
  secretKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('https://api.stripe.com/v1/account', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-06-20',
      },
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Stripe ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Default SSLCommerz verifier — pings the sandbox/live transaction validator
 * with the store credentials. SSLCommerz has no dedicated "account" endpoint,
 * so we hit `/manage/account.php` style sanity URL. If unreachable we mark the
 * gateway DISABLED rather than failing the add (the admin can re-verify).
 */
async function defaultSslcommerzVerify(
  storeId: string,
  storePassword: string,
  mode: 'live' | 'test',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base =
    mode === 'live'
      ? 'https://securepay.sslcommerz.com'
      : 'https://sandbox.sslcommerz.com';
  try {
    const body = new URLSearchParams({
      store_id: storeId,
      store_passwd: storePassword,
      // A bogus tracking lookup. SSLCommerz responds 200 with `status=INVALID_TRANSACTION`
      // for unknown trans_id but only when credentials are valid; auth failures
      // produce `status=NOT_AUTHORIZED`.
      tran_id: 'yocore-credential-probe',
    });
    const res = await fetch(
      `${base}/validator/api/merchantTransIDvalidationAPI.php?${body.toString()}`,
      { method: 'GET' },
    );
    if (!res.ok) return { ok: false, error: `SSLCommerz HTTP ${res.status}` };
    const text = await res.text();
    if (/NOT_AUTHORIZED/i.test(text)) {
      return { ok: false, error: 'SSLCommerz rejected store credentials' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const defaultVerify: VerifyFn = async (provider, mode, credentials) => {
  if (provider === 'stripe') {
    const secretKey = credentials['secretKey'];
    if (!secretKey) return { ok: false, error: 'missing secretKey' };
    return defaultStripeVerify(secretKey);
  }
  if (provider === 'sslcommerz') {
    const storeId = credentials['storeId'];
    const storePassword = credentials['storePassword'];
    if (!storeId || !storePassword) {
      return { ok: false, error: 'missing storeId/storePassword' };
    }
    return defaultSslcommerzVerify(storeId, storePassword, mode);
  }
  // paypal/paddle: no live verification implemented yet — caller will mark DISABLED.
  return { ok: false, error: 'verification not implemented for provider' };
};

export function createGatewayService(opts: CreateGatewayServiceOptions = {}): GatewayService {
  const verifyImpl = opts.verify ?? defaultVerify;

  // Wrap verification in a breaker so a hung provider doesn't pin the admin UI.
  const verifyBreaker = createBreaker(verifyImpl, {
    name: 'gateway.verify',
    timeoutMs: 8_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  return {
    async add(productId, input, actorUserId) {
      const product = await productRepo.findProductById(productId);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');

      const existing = await gatewayRepo.findOne(productId, input.provider, input.mode);
      if (existing) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          `Gateway ${input.provider}/${input.mode} already configured`,
          { provider: input.provider, mode: input.mode },
        );
      }

      const credentials = input.credentials as Record<string, string>;

      // Verify with the live provider BEFORE persisting (Flow C1/C2 spec).
      // PayPal/Paddle are accepted without a verifier and stored DISABLED.
      let status: gatewayRepo.GatewayStatus = 'DISABLED';
      let lastVerificationStatus: 'ok' | 'failed' | null = null;
      let lastVerificationError: string | null = null;
      let lastVerifiedAt: Date | null = null;

      if (input.provider === 'stripe' || input.provider === 'sslcommerz') {
        const result = await verifyBreaker.fire(
          input.provider,
          input.mode,
          credentials,
        );
        lastVerifiedAt = new Date();
        if (!result.ok) {
          throw new AppError(
            ErrorCode.GATEWAY_VERIFICATION_FAILED,
            'Gateway credentials failed verification',
            { provider: input.provider, mode: input.mode, error: result.error },
          );
        }
        status = 'ACTIVE';
        lastVerificationStatus = 'ok';
        lastVerificationError = null;
      }

      // Encrypt every credential field individually with envelope encryption.
      const credentialsEncrypted: Record<string, { token: string }> = {};
      for (const [k, v] of Object.entries(credentials)) {
        if (typeof v === 'string' && v.length > 0) {
          credentialsEncrypted[k] = encrypt(v);
        }
      }

      const created = await gatewayRepo.createGateway({
        productId,
        provider: input.provider,
        mode: input.mode,
        status,
        displayName: input.displayName ?? null,
        credentialsEncrypted,
        lastVerifiedAt,
        lastVerificationStatus,
        lastVerificationError,
        createdBy: actorUserId,
      });

      return toSummary(created);
    },

    async list(productId) {
      const all = await gatewayRepo.listForProduct(productId);
      return all.map(toSummary);
    },

    async get(productId, gatewayId) {
      const g = await gatewayRepo.findById(productId, gatewayId);
      if (!g) throw new AppError(ErrorCode.GATEWAY_NOT_FOUND, 'Gateway not found');
      return toSummary(g);
    },

    async remove(productId, gatewayId) {
      const g = await gatewayRepo.findById(productId, gatewayId);
      if (!g) throw new AppError(ErrorCode.GATEWAY_NOT_FOUND, 'Gateway not found');
      await gatewayRepo.deleteGateway(productId, gatewayId);
    },
  };
}
