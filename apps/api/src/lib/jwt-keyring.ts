/**
 * In-memory JWT signing-key keyring. See ADR-006.
 *
 * Holds:
 *   - exactly one ACTIVE key (used for signing)
 *   - 0..N VERIFYING keys (still accepted on verify, until verifyUntil passes)
 *   - retired keys are dropped from the in-memory map
 *
 * The keyring is populated by a `loader` function (callback into the data
 * layer) so this module stays free of Mongoose. Phase 2.3 wires the loader
 * to the JwtSigningKey collection; Phase 2.4 calls reload() on a Redis
 * pub/sub message + a periodic interval.
 */
import { importJWK, type JWK, type KeyLike } from 'jose';

export type KeyStatus = 'active' | 'verifying' | 'retired';

export interface JwtKeyRecord {
  kid: string;
  status: KeyStatus;
  alg: 'EdDSA' | 'ES256' | 'RS256';
  /** Public key as a JWK (for verify). */
  publicJwk: JWK;
  /** Private key as a JWK (only present for active key). */
  privateJwk?: JWK;
  /** When the key was rotated to verifying status. */
  rotatedAt?: Date;
  /** Verifying keys will not be loaded after this timestamp. */
  verifyUntil?: Date;
}

export interface KeyringSnapshot {
  active: { kid: string; alg: JwtKeyRecord['alg']; privateKey: KeyLike } | undefined;
  verify: ReadonlyMap<string, { alg: JwtKeyRecord['alg']; publicKey: KeyLike }>;
  loadedAt: Date;
}

export type KeyLoader = () => Promise<JwtKeyRecord[]>;

export class JwtKeyring {
  private snapshot: KeyringSnapshot = {
    active: undefined,
    verify: new Map(),
    loadedAt: new Date(0),
  };
  private readonly loader: KeyLoader;

  constructor(loader: KeyLoader) {
    this.loader = loader;
  }

  async reload(now: Date = new Date()): Promise<KeyringSnapshot> {
    const records = await this.loader();
    let active: KeyringSnapshot['active'];
    const verify = new Map<string, { alg: JwtKeyRecord['alg']; publicKey: KeyLike }>();

    let activeCount = 0;
    for (const rec of records) {
      if (rec.status === 'retired') continue;
      if (rec.status === 'verifying' && rec.verifyUntil && rec.verifyUntil.getTime() < now.getTime()) {
        continue;
      }

      const publicKey = (await importJWK(rec.publicJwk, rec.alg)) as KeyLike;
      verify.set(rec.kid, { alg: rec.alg, publicKey });

      if (rec.status === 'active') {
        activeCount += 1;
        if (!rec.privateJwk) throw new Error(`keyring: active key '${rec.kid}' missing privateJwk`);
        const privateKey = (await importJWK(rec.privateJwk, rec.alg)) as KeyLike;
        active = { kid: rec.kid, alg: rec.alg, privateKey };
      }
    }

    if (activeCount > 1) throw new Error('keyring: more than one active key');

    this.snapshot = { active, verify, loadedAt: now };
    return this.snapshot;
  }

  getActive(): KeyringSnapshot['active'] {
    return this.snapshot.active;
  }

  getVerify(kid: string): { alg: JwtKeyRecord['alg']; publicKey: KeyLike } | undefined {
    return this.snapshot.verify.get(kid);
  }

  loadedAt(): Date {
    return this.snapshot.loadedAt;
  }

  /** Test-only — clear the snapshot. */
  __reset(): void {
    this.snapshot = { active: undefined, verify: new Map(), loadedAt: new Date(0) };
  }
}
