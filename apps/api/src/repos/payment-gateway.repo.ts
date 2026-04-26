/**
 * Payment Gateway repository — `paymentGateways` collection.
 *
 * Multi-tenant: every query is scoped by `productId`. Credentials are stored
 * as envelope-encrypted token strings produced by `lib/encryption.ts`. The
 * repo NEVER decrypts; that's the service's job (it owns the live
 * provider-side calls and ensures plaintext secrets never reach the wire log).
 */
import { PaymentGateway, type PaymentGatewayDoc } from '../db/models/PaymentGateway.js';

export type PaymentGatewayLean = PaymentGatewayDoc;

export type GatewayProvider = 'stripe' | 'sslcommerz' | 'paypal' | 'paddle';
export type GatewayMode = 'live' | 'test';
export type GatewayStatus = 'ACTIVE' | 'DISABLED' | 'INVALID_CREDENTIALS';

export async function findById(
  productId: string,
  gatewayId: string,
): Promise<PaymentGatewayLean | null> {
  return PaymentGateway.findOne({ productId, _id: gatewayId }).lean<PaymentGatewayLean | null>();
}

export async function findOne(
  productId: string,
  provider: GatewayProvider,
  mode: GatewayMode,
): Promise<PaymentGatewayLean | null> {
  return PaymentGateway.findOne({ productId, provider, mode }).lean<PaymentGatewayLean | null>();
}

export async function listForProduct(productId: string): Promise<PaymentGatewayLean[]> {
  return PaymentGateway.find({ productId })
    .sort({ provider: 1, mode: 1 })
    .lean<PaymentGatewayLean[]>();
}

export interface CreateGatewayInput {
  productId: string;
  provider: GatewayProvider;
  mode: GatewayMode;
  status: GatewayStatus;
  displayName?: string | null;
  credentialsEncrypted: Record<string, { token: string }>;
  lastVerifiedAt?: Date | null;
  lastVerificationStatus?: 'ok' | 'failed' | null;
  lastVerificationError?: string | null;
  createdBy?: string | null;
}

export async function createGateway(input: CreateGatewayInput): Promise<PaymentGatewayLean> {
  const doc = await PaymentGateway.create({
    productId: input.productId,
    provider: input.provider,
    mode: input.mode,
    status: input.status,
    displayName: input.displayName ?? null,
    credentialsEncrypted: input.credentialsEncrypted,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    lastVerificationStatus: input.lastVerificationStatus ?? null,
    lastVerificationError: input.lastVerificationError ?? null,
    createdBy: input.createdBy ?? null,
  });
  return doc.toObject() as PaymentGatewayLean;
}

export async function updateVerification(
  productId: string,
  gatewayId: string,
  patch: {
    status: GatewayStatus;
    lastVerifiedAt: Date;
    lastVerificationStatus: 'ok' | 'failed';
    lastVerificationError: string | null;
  },
): Promise<PaymentGatewayLean | null> {
  return PaymentGateway.findOneAndUpdate(
    { productId, _id: gatewayId },
    { $set: patch },
    { new: true },
  ).lean<PaymentGatewayLean | null>();
}

export async function setStatus(
  productId: string,
  gatewayId: string,
  status: GatewayStatus,
): Promise<PaymentGatewayLean | null> {
  return PaymentGateway.findOneAndUpdate(
    { productId, _id: gatewayId },
    { $set: { status } },
    { new: true },
  ).lean<PaymentGatewayLean | null>();
}

export async function deleteGateway(productId: string, gatewayId: string): Promise<boolean> {
  const res = await PaymentGateway.deleteOne({ productId, _id: gatewayId });
  return (res.deletedCount ?? 0) > 0;
}
