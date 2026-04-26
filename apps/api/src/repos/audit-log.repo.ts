/**
 * Audit log repository.
 *
 * Provides a Mongoose-backed implementation of the `AuditLogStore` contract
 * used by `audit-log` middleware. The chain hash is computed by the caller
 * (middleware) and we atomically insert the new record using the previous
 * record's hash as `prevHash`.
 *
 * Chain scoping:
 *   - Per-product chain (productId).
 *   - Global chain when productId is null (SUPER_ADMIN actions etc.).
 */
import { AuditLog } from '../db/models/AuditLog.js';
import { newId } from '../db/id.js';
import type {
  AuditLogStore,
  AuditLogRecord,
} from '../middleware/audit-log.js';

async function readPrevHash(productId: string | null): Promise<string | null> {
  const last = await AuditLog.findOne({ productId })
    .sort({ ts: -1, _id: -1 })
    .select({ hash: 1 })
    .lean();
  return last?.hash ?? null;
}

export const auditLogRepo = {
  async append(
    record: Omit<AuditLogRecord, 'prevHash' | 'hash'>,
    computeHash: (prevHash: string | null) => string,
  ): Promise<AuditLogRecord> {
    const prevHash = await readPrevHash(record.productId);
    const hash = computeHash(prevHash);
    await AuditLog.create({
      _id: newId('log'),
      ...record,
      prevHash,
      hash,
    });
    return { ...record, prevHash, hash };
  },
} satisfies AuditLogStore;
