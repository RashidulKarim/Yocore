/**
 * JWT signing-key rotation — Flow Y (V1.0-C).
 *
 * `rotateActiveKey()` does Y1–Y6:
 *   1. Generate Ed25519 keypair (`jose.generateKeyPair('EdDSA', extractable:true)`).
 *   2. Encrypt private JWK at rest (envelope AES-256-GCM via lib/encryption).
 *   3. Insert NEW row {status:'active'}.
 *   4. Atomically demote previous active → {status:'verifying', verifyUntil:now+30m}.
 *   5. Publish `keyring:reload` on Redis pub/sub so all pods refresh in-memory keyring.
 *   6. Audit `jwt.key.rotated`.
 *
 * `retireExpiredVerifyingKeys()` is the cron `jwt.key.retire` (Y7) — flips
 * `status:'verifying'` rows whose `verifyUntil` has passed to `status:'retired'`.
 */
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import type { Redis } from 'ioredis';
import { JwtSigningKey } from '../db/models/JwtSigningKey.js';
import { encrypt } from '../lib/encryption.js';
import { newId } from '../db/id.js';
import type { JwtKeyring } from '../lib/jwt-keyring.js';
import {
  type AuditLogStore,
  type AuditLogRecord,
  computeAuditHash,
} from '../middleware/audit-log.js';

export const KEYRING_RELOAD_CHANNEL = 'keyring:reload';
export const VERIFY_GRACE_MS = 30 * 60 * 1000; // 30 minutes (2× max access TTL of 15m)

export interface JwtRotationService {
  rotateActiveKey(actor: { type: 'super_admin' | 'system'; id: string }): Promise<{
    newKid: string;
    oldKid: string | null;
    verifyUntil: Date;
  }>;
  retireExpiredVerifyingKeys(now?: Date): Promise<{ retired: number }>;
}

export interface CreateJwtRotationServiceOptions {
  redis: Redis;
  keyring: JwtKeyring;
  auditStore: AuditLogStore;
  /** Override clock (tests). */
  now?: () => Date;
}

export function createJwtRotationService(
  opts: CreateJwtRotationServiceOptions,
): JwtRotationService {
  const now = opts.now ?? (() => new Date());
  return {
    async rotateActiveKey(actor) {
      const t = now();
      // Y1.
      const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
      const publicJwk = (await exportJWK(publicKey)) as JWK;
      const privateJwk = (await exportJWK(privateKey)) as JWK;
      // Y2.
      const privateKeyEncrypted = encrypt(JSON.stringify(privateJwk)).token;
      // Y3.
      const newKid = newId('kid');
      await JwtSigningKey.create({
        _id: newKid,
        algorithm: 'EdDSA',
        publicKey: JSON.stringify(publicJwk),
        privateKeyEncrypted,
        status: 'active',
        activatedAt: t,
      });
      // Y4. Demote previous active(s) → verifying.
      const verifyUntil = new Date(t.getTime() + VERIFY_GRACE_MS);
      const demoted = await JwtSigningKey.findOneAndUpdate(
        { status: 'active', _id: { $ne: newKid } },
        { $set: { status: 'verifying', rotatedAt: t, verifyUntil } },
        { new: true },
      ).lean<{ _id: string } | null>();
      // Y5. Notify other pods.
      try {
        await opts.redis.publish(KEYRING_RELOAD_CHANNEL, newKid);
      } catch {
        // pub/sub failure is non-fatal — local reload still happens below.
      }
      // Local reload too.
      await opts.keyring.reload(t);
      // Y6.
      await emitAudit(opts.auditStore, {
        action: 'jwt.key.rotated',
        outcome: 'success',
        actor,
        resource: { type: 'jwt_key', id: newKid },
        metadata: {
          newKid,
          oldKid: demoted?._id ?? null,
          verifyUntil: verifyUntil.toISOString(),
        },
      });
      return { newKid, oldKid: demoted?._id ?? null, verifyUntil };
    },

    async retireExpiredVerifyingKeys(at) {
      const t = at ?? now();
      const res = await JwtSigningKey.updateMany(
        { status: 'verifying', verifyUntil: { $lte: t } },
        { $set: { status: 'retired', retiredAt: t } },
      );
      const retired = res.modifiedCount;
      if (retired > 0) {
        // Reload keyring locally + broadcast so pods drop these from in-memory cache.
        try {
          await opts.redis.publish(KEYRING_RELOAD_CHANNEL, 'retire');
        } catch {
          // ignore
        }
        await opts.keyring.reload(t);
        await emitAudit(opts.auditStore, {
          action: 'jwt.key.retired',
          outcome: 'success',
          actor: { type: 'system', id: 'cron:jwt.key.retire' },
          resource: { type: 'jwt_key', id: 'batch' },
          metadata: { retiredCount: retired },
        });
      }
      return { retired };
    },
  };
}

interface AuditInput {
  action: string;
  outcome: 'success' | 'failure';
  actor: { type: string; id?: string | undefined };
  productId?: string | null;
  workspaceId?: string | null;
  resource?: { type: string; id: string };
  metadata?: Record<string, unknown>;
}

async function emitAudit(store: AuditLogStore, input: AuditInput): Promise<void> {
  const record: Omit<AuditLogRecord, 'prevHash' | 'hash'> = {
    ts: new Date(),
    productId: input.productId ?? null,
    workspaceId: input.workspaceId ?? null,
    actor: {
      type: input.actor.type as AuditLogRecord['actor']['type'],
      id: input.actor.id ?? null,
      ip: null,
      userAgent: null,
      apiKeyId: null,
      sessionId: null,
      correlationId: null,
    },
    action: input.action,
    resource: input.resource
      ? { type: input.resource.type, id: input.resource.id }
      : { type: null, id: null },
    outcome: input.outcome,
    reason: null,
    metadata: input.metadata ?? {},
  };
  await store.append(record, (prev) => computeAuditHash(prev, record));
}
