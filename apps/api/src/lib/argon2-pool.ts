/**
 * Argon2id worker pool (piscina). See ADR-007.
 *
 * Why: argon2.hash blocks the calling thread for ~80–120ms at production params.
 * Off-loading to a worker pool keeps the main event loop free.
 *
 * Test mode (NODE_ENV=test): runs inline (no worker spawn) with low params for speed.
 *
 * Public API:
 *   argonHash(password) -> Promise<string>
 *   argonVerify(hash, password) -> Promise<boolean>
 *   destroyArgonPool() -> Promise<void>   // for graceful shutdown / tests
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import argon2 from 'argon2';
import { Piscina } from 'piscina';
import { env } from '../config/env.js';

/** Production parameters per OWASP 2024 Argon2id guidance. */
export const ARGON2_PROD_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Test parameters — fast enough for unit tests but still real Argon2. */
export const ARGON2_TEST_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1024, // minimum allowed by argon2 lib
  timeCost: 2,
  parallelism: 1,
};

function activeOptions(): argon2.Options {
  return env.NODE_ENV === 'test' ? ARGON2_TEST_OPTIONS : ARGON2_PROD_OPTIONS;
}

let pool: Piscina | undefined;

function getPool(): Piscina {
  if (pool) return pool;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The compiled worker is emitted alongside this file as argon2-worker.js.
  const filename = path.join(here, 'argon2-worker.js');
  pool = new Piscina({
    filename,
    minThreads: env.ARGON2_POOL_SIZE,
    maxThreads: env.ARGON2_POOL_SIZE,
    idleTimeout: 30_000,
  });
  return pool;
}

export async function argonHash(password: string): Promise<string> {
  if (env.NODE_ENV === 'test') {
    return argon2.hash(password, activeOptions());
  }
  const result = (await getPool().run({
    kind: 'hash',
    password,
    options: activeOptions(),
  })) as { kind: 'hash'; hash: string };
  return result.hash;
}

export async function argonVerify(hash: string, password: string): Promise<boolean> {
  if (env.NODE_ENV === 'test') {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
  try {
    const result = (await getPool().run({ kind: 'verify', hash, password })) as {
      kind: 'verify';
      ok: boolean;
    };
    return result.ok;
  } catch {
    return false;
  }
}

export async function destroyArgonPool(): Promise<void> {
  if (!pool) return;
  await pool.destroy();
  pool = undefined;
}
