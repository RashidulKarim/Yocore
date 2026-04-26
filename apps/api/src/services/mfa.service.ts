/**
 * MFA service — TOTP enrolment + verification + recovery codes.
 *
 * Implements Flows A1b/c (super-admin TOTP enrol/verify) and V (recovery
 * codes). Recovery codes are formatted as 5+5 hex chars (e.g. `A1B2C-D3E4F`)
 * and stored only as sha256 hashes.
 *
 * The TOTP secret is envelope-encrypted at rest via `lib/encryption`.
 */
import { authenticator } from 'otplib';
import { encrypt, decryptToString } from '../lib/encryption.js';
import { hashToken } from '../lib/tokens.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import * as mfaRepo from '../repos/mfa.repo.js';
import { randomBytes } from 'node:crypto';
import { AuthLimits } from '@yocore/types';

authenticator.options = { window: 1, step: 30, digits: 6 };

const TOTP_ISSUER = 'YoCore';

export interface StartTotpEnrolmentInput {
  userId: string;
  productId: string | null;
  accountLabel: string;
}

export interface StartTotpEnrolmentResult {
  enrolmentId: string;
  otpauthUri: string;
  secret: string;
}

export async function startTotpEnrolment(
  input: StartTotpEnrolmentInput,
): Promise<StartTotpEnrolmentResult> {
  // Block restart if a verified TOTP already exists.
  const existing = await mfaRepo.findVerifiedTotp(input.userId, input.productId);
  if (existing) {
    throw new AppError(
      ErrorCode.RESOURCE_CONFLICT,
      'MFA is already enrolled. Disable it before re-enrolling.',
    );
  }

  // Wipe any prior pending enrolments + recovery codes (clean slate).
  await mfaRepo.deleteAllForUserProduct(input.userId, input.productId);

  const secret = authenticator.generateSecret(20); // 160-bit base32
  const otpauthUri = authenticator.keyuri(input.accountLabel, TOTP_ISSUER, secret);

  const row = await mfaRepo.createPendingTotp({
    userId: input.userId,
    productId: input.productId,
    secretEncrypted: encrypt(secret).token,
    accountLabel: input.accountLabel,
  });

  return { enrolmentId: row._id, otpauthUri, secret };
}

export interface VerifyTotpEnrolmentInput {
  userId: string;
  productId: string | null;
  enrolmentId: string;
  code: string;
}

export interface VerifyTotpEnrolmentResult {
  recoveryCodes: string[];
}

export async function verifyTotpEnrolment(
  input: VerifyTotpEnrolmentInput,
): Promise<VerifyTotpEnrolmentResult> {
  const pending = await mfaRepo.findPendingTotp(input.enrolmentId, input.userId);
  if (!pending || !pending.secretEncrypted) {
    throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Invalid enrolment');
  }

  const secret = decryptToString(pending.secretEncrypted);
  const ok = authenticator.verify({ token: input.code, secret });
  if (!ok) throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Invalid code');

  const marked = await mfaRepo.markTotpVerified(input.enrolmentId, 0);
  if (!marked) {
    throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Enrolment already used or revoked');
  }

  // Issue 10 fresh recovery codes — return plain to caller, store hashes only.
  const plain = generateRecoveryCodes(AuthLimits.RECOVERY_CODES_COUNT);
  const hashes = plain.map(hashToken);
  await mfaRepo.deleteAllRecovery(input.userId, input.productId);
  await mfaRepo.insertRecoveryCodes({
    userId: input.userId,
    productId: input.productId,
    codeHashes: hashes,
  });

  return { recoveryCodes: plain };
}

export interface VerifyMfaCodeInput {
  userId: string;
  productId: string | null;
  code: string;
}

/**
 * Verify a TOTP or recovery code presented at sign-in time.
 * Throws AUTH_MFA_INVALID_CODE on any failure.
 */
export async function verifyMfaCode(input: VerifyMfaCodeInput): Promise<void> {
  const code = input.code.trim();
  // Recovery codes look like "ABCDE-FGHIJ" (uppercase hex). TOTP codes are 6 digits.
  const isRecovery = /^[A-Z0-9-]{8,}$/.test(code) && /-/.test(code);

  if (isRecovery) {
    const codeHash = hashToken(code.toUpperCase());
    const row = await mfaRepo.findUnusedRecoveryByHash({
      userId: input.userId,
      productId: input.productId,
      codeHash,
    });
    if (!row) throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Invalid recovery code');
    const used = await mfaRepo.markRecoveryUsed(row._id);
    if (!used) throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Recovery code already used');
    return;
  }

  const totp = await mfaRepo.findVerifiedTotp(input.userId, input.productId);
  if (!totp || !totp.secretEncrypted) {
    throw new AppError(ErrorCode.AUTH_MFA_NOT_ENROLLED, 'MFA not enrolled');
  }

  const secret = decryptToString(totp.secretEncrypted);
  const counter = Math.floor(Date.now() / 1000 / authenticator.options.step!);

  if (totp.lastUsedCounter && counter <= totp.lastUsedCounter) {
    // Replay protection: the same TOTP step has already been consumed.
    throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Code already used');
  }

  const ok = authenticator.verify({ token: code, secret });
  if (!ok) throw new AppError(ErrorCode.AUTH_MFA_INVALID_CODE, 'Invalid code');

  await mfaRepo.recordTotpUse(totp._id, counter);
}

export async function isMfaEnrolled(
  userId: string,
  productId: string | null,
): Promise<boolean> {
  const row = await mfaRepo.findVerifiedTotp(userId, productId);
  return row !== null;
}

export async function regenerateRecoveryCodes(
  userId: string,
  productId: string | null,
): Promise<string[]> {
  const enrolled = await isMfaEnrolled(userId, productId);
  if (!enrolled) throw new AppError(ErrorCode.AUTH_MFA_NOT_ENROLLED, 'MFA not enrolled');

  const plain = generateRecoveryCodes(AuthLimits.RECOVERY_CODES_COUNT);
  const hashes = plain.map(hashToken);
  await mfaRepo.deleteAllRecovery(userId, productId);
  await mfaRepo.insertRecoveryCodes({ userId, productId, codeHashes: hashes });
  return plain;
}

export async function countUnusedRecovery(
  userId: string,
  productId: string | null,
): Promise<number> {
  return mfaRepo.countUnusedRecovery(userId, productId);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRecoveryCodes(n: number): string[] {
  const codes = new Set<string>();
  while (codes.size < n) {
    const left = randomCode(5);
    const right = randomCode(5);
    codes.add(`${left}-${right}`);
  }
  return Array.from(codes);
}

function randomCode(len: number): string {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += RECOVERY_ALPHABET[buf[i]! % RECOVERY_ALPHABET.length];
  }
  return out;
}
