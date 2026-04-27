/**
 * Phase 3.5 — Bundle cancel cascade cron (Flow AK).
 *
 * Daily job: scans `subscriptions` for bundle PARENTS with status=CANCELED
 * within the last 7 days. For each, finds active children and:
 *   1. Marks them CANCELED with cancelReason='bundle_parent_canceled'
 *   2. Pushes a `changeHistory` entry (system actor)
 *   3. Enqueues an outbound `bundle.subscription.canceled` webhook to each
 *      component product
 *   4. Writes an audit log entry per child
 *
 * Idempotent — re-running over the same window is a no-op.
 *
 * Locked via the framework's CronLockStore (`name='bundle.cancel.cascade'`).
 */
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { logger } from '../lib/logger.js';
import {
  computeAuditHash,
  type AuditLogStore,
  type AuditLogRecord,
} from '../middleware/audit-log.js';

const CASCADE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface BundleCascadeReport {
  scannedParents: number;
  canceledChildren: number;
  errors: number;
}

export interface BundleCascadeService {
  runBundleCancelCascade(opts?: { now?: Date }): Promise<BundleCascadeReport>;
}

export interface CreateBundleCascadeServiceOptions {
  auditStore: AuditLogStore;
}

export function createBundleCascadeService(
  opts: CreateBundleCascadeServiceOptions,
): BundleCascadeService {
  const auditStore = opts.auditStore;

  return {
    async runBundleCancelCascade({ now = new Date() } = {}) {
      const since = new Date(now.getTime() - CASCADE_WINDOW_MS);
      const parents = await subscriptionRepo.listCanceledBundleParents(since, 500);
      const report: BundleCascadeReport = {
        scannedParents: parents.length,
        canceledChildren: 0,
        errors: 0,
      };

      for (const parent of parents) {
        try {
          const children = await subscriptionRepo.listBundleChildren(parent._id, {
            excludeStatuses: ['CANCELED', 'INCOMPLETE'],
          });
          for (const child of children) {
            const updated = await subscriptionRepo.cancelBundleChild({
              childId: child._id,
              reason: 'bundle_parent_canceled',
              at: now,
              changedBy: 'cron:bundle.cancel.cascade',
            });
            if (!updated) continue;
            report.canceledChildren += 1;

            // Outbound webhook to component product.
            const product = await productRepo.findProductById(child.productId);
            if (product?.webhookUrl) {
              await deliveryRepo
                .enqueueDelivery({
                  productId: child.productId,
                  event: 'bundle.subscription.canceled',
                  eventId: `evt_bdl_cancel_${child._id}`,
                  url: product.webhookUrl,
                  payloadRef: child._id,
                })
                .catch(() => undefined);
            }

            // Audit (cron actor).
            await appendCascadeAudit(auditStore, {
              productId: child.productId,
              workspaceId: child.subjectWorkspaceId ?? null,
              resource: { type: 'subscription', id: child._id },
              metadata: {
                bundleSubscriptionId: parent._id,
                bundleId: parent.bundleId ?? null,
              },
            }).catch(() => undefined);
          }
        } catch (err) {
          report.errors += 1;
          logger.error(
            { err, parentSubscriptionId: parent._id },
            'bundle.cancel.cascade.error',
          );
        }
      }

      logger.info({ event: 'bundle.cancel.cascade', ...report }, 'bundle.cancel.cascade complete');
      return report;
    },
  };
}

async function appendCascadeAudit(
  store: AuditLogStore,
  event: {
    productId: string | null;
    workspaceId: string | null;
    resource: { type: string; id: string };
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const body: Omit<AuditLogRecord, 'prevHash' | 'hash'> = {
    ts: new Date(),
    productId: event.productId,
    workspaceId: event.workspaceId,
    actor: {
      type: 'system',
      id: 'cron:bundle.cancel.cascade',
      ip: null,
      userAgent: null,
      apiKeyId: null,
      sessionId: null,
      correlationId: null,
    },
    action: 'subscription.canceled',
    resource: { type: event.resource.type, id: event.resource.id },
    outcome: 'success',
    reason: 'bundle_parent_canceled',
    metadata: event.metadata ?? {},
  };
  await store.append(body, (prev) => computeAuditHash(prev, body));
}
