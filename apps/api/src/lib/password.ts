/**
 * Password hashing facade. ALWAYS use this — never call argon2 directly.
 *
 * - hash(): goes through Argon2id worker pool (off event loop). See ADR-007.
 * - verify(): same path; returns false on any malformed input rather than throwing.
 * - timingSafeDummyVerify(): for FIX-AUTH-TIMING — runs a real verify against a
 *   stable dummy hash so signin / signup paths take constant-ish time even when
 *   the user does not exist.
 */
import { argonHash, argonVerify } from './argon2-pool.js';

export async function hash(password: string): Promise<string> {
  return argonHash(password);
}

export async function verify(passwordHash: string, password: string): Promise<boolean> {
  if (!passwordHash || !password) return false;
  return argonVerify(passwordHash, password);
}

/**
 * A pre-computed Argon2id hash of the literal string 'yocore-timing-dummy-v1'.
 * NOT a secret — its purpose is to give us a real hash to verify against when
 * the looked-up user does not exist, so attackers can't time-distinguish.
 *
 * Lazily initialised on first call to keep module load cheap.
 */
let dummyHash: string | undefined;
const DUMMY_PASSWORD = 'yocore-timing-dummy-v1';

export async function timingSafeDummyVerify(): Promise<void> {
  if (!dummyHash) dummyHash = await argonHash(DUMMY_PASSWORD);
  // Wrong password — must return false; we ignore the result.
  await argonVerify(dummyHash, 'definitely-not-the-dummy');
}

/** Test-only — reset the cached dummy hash (e.g. between describe blocks). */
export function __resetDummyHashForTests(): void {
  dummyHash = undefined;
}
