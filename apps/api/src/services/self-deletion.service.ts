/**
 * Self-deletion service — Flow X (V1.0-B).
 *
 * Implements user-initiated deletion with 30-day grace:
 *   - `requestDeletion({scope, productId?, userId})` — pre-flight blockers, then
 *     create a `deletionRequests` row with `finalizeAt = now + 30d`.
 *   - `cancelDeletion({userId, productId?})` — flips PENDING → CANCELED.
 *   - `runDeletionTick({now})` — cron handler. Finds PENDING rows whose
 *     `finalizeAt <= now`, performs hard erase per scope, marks FINALIZED.
 *
 * Pre-flight blockers (per §1.20 + Flow X3):
 *   - Active subscription that is NOT scheduled to cancel-at-period-end → BLOCKED.
 *   - User is sole owner of a workspace with other members → BLOCKED
 *     (`workspace_ownership_required`). The user must transfer or delete first.
 */
import type { ClientSession } from 'mongoose';
import { DeletionRequest } from '../db/models/DeletionRequest.js';
import { Subscription } from '../db/models/Subscription.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { User } from '../db/models/User.js';
import { Session } from '../db/models/Session.js';
import { AppError, ErrorCode } from '../lib/errors.js';

export const DELETION_GRACE_DAYS = 30;
export const DELETION_GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface SelfDeletionService {
  requestDeletion(input: {
    userId: string;
    scope: 'product' | 'account';
    productId?: string;
    now?: Date;
  }): Promise<{
    deletionRequestId: string;
    finalizeAt: Date;
    scope: 'product' | 'account';
    productId: string | null;
  }>;
  cancelDeletion(input: {
    userId: string;
    scope: 'product' | 'account';
    productId?: string;
  }): Promise<{ canceled: boolean }>;
  listForUser(userId: string): Promise<
    Array<{
      id: string;
      scope: 'product' | 'account';
      productId: string | null;
      status: string;
      requestedAt: Date;
      finalizeAt: Date;
    }>
  >;
  runDeletionTick(now?: Date): Promise<{ finalized: number; failed: number }>;
}

export function createSelfDeletionService(): SelfDeletionService {
  return {
    async requestDeletion({ userId, scope, productId, now }) {
      const t = now ?? new Date();
      if (scope === 'product' && !productId) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'productId is required for product-scoped deletion',
        );
      }
      // Reject if pending row already exists for same scope.
      const existing = await DeletionRequest.findOne({
        userId,
        productId: scope === 'account' ? null : productId,
        status: 'PENDING',
      }).lean();
      if (existing) {
        throw new AppError(ErrorCode.GDPR_DELETION_PENDING, 'Deletion already pending');
      }
      // Pre-flight: active subs not cancelling at period end.
      const subFilter =
        scope === 'product'
          ? { productId, subjectUserId: userId }
          : { subjectUserId: userId };
      const blockingSub = await Subscription.findOne({
        ...subFilter,
        status: { $in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        cancelAtPeriodEnd: { $ne: true },
      }).lean<{ _id: string; productId: string } | null>();
      if (blockingSub) {
        throw new AppError(
          ErrorCode.GDPR_DELETION_BLOCKED,
          'Active subscription must be canceled (or set to cancel at period end) before deletion',
          {
            details: {
              reason: 'active_subscription',
              subscriptionId: blockingSub._id,
              productId: blockingSub.productId,
            },
          },
        );
      }
      // Pre-flight: workspace ownership.
      const ownedWorkspacesFilter =
        scope === 'product' ? { productId, ownerUserId: userId } : { ownerUserId: userId };
      const owned = await Workspace.find({
        ...ownedWorkspacesFilter,
        deletedAt: null,
      })
        .select('_id productId')
        .lean<{ _id: string; productId: string }[]>();
      if (owned.length > 0) {
        // If any owned workspace has other active members, block.
        for (const w of owned) {
          const others = await WorkspaceMember.countDocuments({
            productId: w.productId,
            workspaceId: w._id,
            userId: { $ne: userId },
            status: 'ACTIVE',
          });
          if (others > 0) {
            throw new AppError(
              ErrorCode.GDPR_DELETION_BLOCKED,
              'Transfer or delete owned workspaces with other members first',
              {
                details: {
                  reason: 'workspace_ownership_required',
                  workspaceId: w._id,
                  productId: w.productId,
                },
              },
            );
          }
        }
      }
      const finalizeAt = new Date(t.getTime() + DELETION_GRACE_MS);
      const created = await DeletionRequest.create({
        userId,
        scope,
        productId: scope === 'product' ? productId : null,
        requestedAt: t,
        finalizeAt,
        status: 'PENDING',
      });
      // Revoke all active sessions matching scope so user is logged out.
      const sessionFilter =
        scope === 'product' ? { userId, productId } : { userId };
      await Session.updateMany(
        { ...sessionFilter, revokedAt: null },
        { $set: { revokedAt: t, revokedReason: 'admin' } },
      );
      return {
        deletionRequestId: created._id,
        finalizeAt,
        scope,
        productId: scope === 'product' ? productId ?? null : null,
      };
    },

    async cancelDeletion({ userId, scope, productId }) {
      const filter = {
        userId,
        scope,
        productId: scope === 'account' ? null : (productId ?? null),
        status: 'PENDING',
      };
      const res = await DeletionRequest.updateOne(filter, {
        $set: { status: 'CANCELED', canceledAt: new Date() },
      });
      return { canceled: res.modifiedCount > 0 };
    },

    async listForUser(userId) {
      const rows = await DeletionRequest.find({ userId })
        .sort({ requestedAt: -1 })
        .limit(20)
        .lean<
          Array<{
            _id: string;
            scope: 'product' | 'account';
            productId: string | null;
            status: string;
            requestedAt: Date;
            finalizeAt: Date;
          }>
        >();
      return rows.map((r) => ({
        id: r._id,
        scope: r.scope,
        productId: r.productId,
        status: r.status,
        requestedAt: r.requestedAt,
        finalizeAt: r.finalizeAt,
      }));
    },

    async runDeletionTick(now) {
      const t = now ?? new Date();
      const cronRunId = `cron:gdpr.deletion.tick:${t.toISOString()}`;
      const due = await DeletionRequest.find({
        status: 'PENDING',
        finalizeAt: { $lte: t },
      })
        .limit(100)
        .lean<
          Array<{
            _id: string;
            userId: string;
            scope: 'product' | 'account';
            productId: string | null;
          }>
        >();
      let finalized = 0;
      let failed = 0;
      for (const row of due) {
        try {
          await finalizeDeletion(row, t, cronRunId, undefined);
          finalized++;
        } catch {
          failed++;
        }
      }
      return { finalized, failed };
    },
  };
}

/** Hard-erase per scope, then mark request FINALIZED. */
async function finalizeDeletion(
  row: {
    _id: string;
    userId: string;
    scope: 'product' | 'account';
    productId: string | null;
  },
  t: Date,
  cronRunId: string,
  session: ClientSession | undefined,
): Promise<void> {
  if (row.scope === 'product' && row.productId) {
    // Erase ProductUser PII + workspace memberships in this product.
    await ProductUser.updateOne(
      { productId: row.productId, userId: row.userId },
      {
        $set: {
          status: 'DELETED',
          email: `deleted+${row.userId}@yocore.invalid`,
          firstName: null,
          lastName: null,
          phone: null,
          avatarUrl: null,
          passwordHash: null,
          deletedAt: t,
        },
      },
      session ? { session } : undefined,
    );
    await WorkspaceMember.updateMany(
      { productId: row.productId, userId: row.userId },
      { $set: { status: 'REMOVED', removedAt: t } },
      session ? { session } : undefined,
    );
  } else {
    // Account-wide: erase User PII + cascade ProductUser rows.
    await User.updateOne(
      { _id: row.userId },
      {
        $set: {
          email: `deleted+${row.userId}@yocore.invalid`,
          emailNormalized: `deleted+${row.userId}@yocore.invalid`,
          passwordHash: null,
        },
      },
      session ? { session } : undefined,
    );
    await ProductUser.updateMany(
      { userId: row.userId },
      {
        $set: {
          status: 'DELETED',
          email: `deleted+${row.userId}@yocore.invalid`,
          firstName: null,
          lastName: null,
          phone: null,
          deletedAt: t,
        },
      },
      session ? { session } : undefined,
    );
    await WorkspaceMember.updateMany(
      { userId: row.userId },
      { $set: { status: 'REMOVED', removedAt: t } },
      session ? { session } : undefined,
    );
    await Session.updateMany(
      { userId: row.userId, revokedAt: null },
      { $set: { revokedAt: t, revokedReason: 'admin' } },
      session ? { session } : undefined,
    );
  }
  await DeletionRequest.updateOne(
    { _id: row._id, status: 'PENDING' },
    {
      $set: {
        status: 'FINALIZED',
        finalizedAt: t,
        finalizedByCronRun: cronRunId,
      },
    },
    session ? { session } : undefined,
  );
}
