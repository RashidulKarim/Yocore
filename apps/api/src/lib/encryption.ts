/**
 * Envelope encryption: AES-256-GCM with a per-payload Data Encryption Key (DEK)
 * wrapped by a Key Encryption Key (KEK). The KEK is `YOCORE_KMS_KEY` (32-byte
 * hex) — in production this comes from AWS KMS / Secrets Manager; in dev/test
 * it is a deterministic env var.
 *
 * Output format (base64url):
 *   v1.<wrappedDek>.<dekIv>.<dekTag>.<payloadIv>.<payloadCiphertext>.<payloadTag>
 *
 * Why envelope: rotating the KEK only requires re-wrapping the DEKs, not
 * decrypting+re-encrypting all data. (Re-wrap not implemented yet — Phase 5.)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 'v1' as const;
const ALG = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

function getKek(): Buffer {
  const hex = env.YOCORE_KMS_KEY;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_BYTES) throw new Error('YOCORE_KMS_KEY must decode to 32 bytes');
  return buf;
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64u(s: string, label: string): Buffer {
  const buf = Buffer.from(s, 'base64url');
  if (buf.length === 0) throw new Error(`encryption: empty segment '${label}'`);
  return buf;
}

export interface EncryptedEnvelope {
  /** Self-describing string token. Store this in Mongo. */
  token: string;
}

export function encrypt(plaintext: string | Buffer): EncryptedEnvelope {
  const kek = getKek();
  const dek = randomBytes(KEY_BYTES);

  // Wrap the DEK under KEK.
  const dekIv = randomBytes(IV_BYTES);
  const dekCipher = createCipheriv(ALG, kek, dekIv);
  const wrappedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekTag = dekCipher.getAuthTag();

  // Encrypt the payload under DEK.
  const payloadIv = randomBytes(IV_BYTES);
  const payloadCipher = createCipheriv(ALG, dek, payloadIv);
  const payloadBuf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([payloadCipher.update(payloadBuf), payloadCipher.final()]);
  const payloadTag = payloadCipher.getAuthTag();

  const token = [
    VERSION,
    b64u(wrappedDek),
    b64u(dekIv),
    b64u(dekTag),
    b64u(payloadIv),
    b64u(ciphertext),
    b64u(payloadTag),
  ].join('.');

  return { token };
}

export function decrypt(token: string): Buffer {
  if (typeof token !== 'string') throw new Error('encryption: token must be a string');
  const parts = token.split('.');
  if (parts.length !== 7) throw new Error('encryption: malformed token');
  const [version, wrappedDekS, dekIvS, dekTagS, payloadIvS, ciphertextS, payloadTagS] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) throw new Error(`encryption: unsupported version '${version}'`);

  const kek = getKek();
  const wrappedDek = fromB64u(wrappedDekS, 'wrappedDek');
  const dekIv = fromB64u(dekIvS, 'dekIv');
  const dekTag = fromB64u(dekTagS, 'dekTag');
  const payloadIv = fromB64u(payloadIvS, 'payloadIv');
  const ciphertext = fromB64u(ciphertextS, 'ciphertext');
  const payloadTag = fromB64u(payloadTagS, 'payloadTag');

  if (dekTag.length !== TAG_BYTES || payloadTag.length !== TAG_BYTES) {
    throw new Error('encryption: invalid auth tag length');
  }

  const dekDecipher = createDecipheriv(ALG, kek, dekIv);
  dekDecipher.setAuthTag(dekTag);
  const dek = Buffer.concat([dekDecipher.update(wrappedDek), dekDecipher.final()]);

  const payloadDecipher = createDecipheriv(ALG, dek, payloadIv);
  payloadDecipher.setAuthTag(payloadTag);
  return Buffer.concat([payloadDecipher.update(ciphertext), payloadDecipher.final()]);
}

export function decryptToString(token: string): string {
  return decrypt(token).toString('utf8');
}
