/**
 * SSLCommerz IPN signature verification.
 *
 * SSLCommerz signs IPN POST bodies with one of two algorithms:
 *
 *   1. **MD5 (`verify_sign`):**
 *        sig = md5(`${field}=${value}&...`)
 *      where `field=value` pairs are taken from the request body, restricted
 *      to keys listed in the `verify_key` field (sorted alphabetically), and
 *      followed by `&store_passwd=<md5(store_passwd)>`.
 *
 *   2. **SHA-2 (`verify_sign_sha2`):**
 *        same canonical string, signed with HMAC-SHA256 keyed by `store_passwd`.
 *
 * Both methods operate on the *parsed form fields*, NOT on raw bytes — so we
 * verify after express's `urlencoded` parser. We support both algorithms; the
 * stronger SHA-2 form takes precedence when present.
 *
 * See: https://developer.sslcommerz.com/doc/v4/#ipn  (Section "IPN
 * Verification (Hash verification)").
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from './errors.js';

export interface VerifyIpnInput {
  /** Parsed form body from SSLCommerz IPN. */
  body: Record<string, string | undefined>;
  /** Plain `store_passwd` for the merchant (decrypted from gateway store). */
  storePasswd: string;
}

export function verifySslcommerzIpn(input: VerifyIpnInput): void {
  const { body, storePasswd } = input;
  if (!storePasswd) throw new Error('verifySslcommerzIpn: storePasswd is required');

  const verifyKey = body['verify_key'];
  const provided = body['verify_sign'];
  const providedSha2 = body['verify_sign_sha2'];

  if (!verifyKey || (!provided && !providedSha2)) {
    throw new AppError(
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      'Missing verify_key / verify_sign(_sha2) in IPN body',
    );
  }

  // Build the canonical string. Per SSLCommerz docs the keys in `verify_key`
  // are already in the correct order (alphabetical), but we sort defensively.
  const keys = verifyKey.split(',').map((k) => k.trim()).filter(Boolean).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = body[k] ?? '';
    parts.push(`${k}=${v}`);
  }
  const passwdHash = createHash('md5').update(storePasswd).digest('hex');
  parts.push(`store_passwd=${passwdHash}`);
  const canonical = parts.join('&');

  // Prefer SHA-2 when both are present.
  if (providedSha2) {
    const expected = createHmac('sha256', storePasswd).update(canonical).digest('hex');
    safeEqualHex(expected, providedSha2);
    return;
  }
  if (provided) {
    const expected = createHash('md5').update(canonical).digest('hex');
    safeEqualHex(expected, provided);
  }
}

function safeEqualHex(expected: string, provided: string): void {
  const a = Buffer.from(expected.toLowerCase(), 'utf8');
  const b = Buffer.from(provided.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
      'SSLCommerz IPN signature mismatch',
    );
  }
}
