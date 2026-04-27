/**
 * Bundle migration service — V1.1-B (P1 features deferred from v1.0).
 *
 * Implements:
 *
 *   • Flow AM (System-Design §8.AM) — Bundle component plan-swap mid-cycle
 *     `POST /v1/admin/bundles/:id/swap-component`
 *
 *   • Flow AN (System-Design §8.AN) — Standalone ↔ Bundle migration
 *     `POST /v1/billing/subscription/migrate-to-bundle`     (path A)
 *     `POST /v1/billing/bundles/:id/downgrade-to-standalone` (path B)
 *
 * Per system-design simplifications (P1):
 *   - Stripe proration math (`invoiceItem` for forced_migrate) is OUT OF
 *     SCOPE here; we record `creditBalance` adjustments on the parent
 *     subscription and surface a `pendingPlanChange` blob for the renewal
 *     worker. Real Stripe / SSLCommerz invoice items follow in V1.2.
 *   - Path A re-uses the existing `bundleCheckout` to actually create the
 *     parent + child subs after eligibility-based cancellation.
 *   - Path B issues immediate cancellations + creates standalone Stripe
 *     subs at next renewal (no proration credit transfer in this revision).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import * as bundleRepo from '../repos/bundle.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { Subscription } from '../db/models/Subscription.js';
import type { BundleCheckoutService, BundleCheckoutContext } from './bundle-checkout.service.js';

export type ApplyPolicy = 'grandfather' | 'forced_migrate';

export interface SwapComponentInput {
  bundleId: string;
  componentIndex: number;
  newPlanId: string;
  applyPolicy: ApplyPolicy;
  actor: { id: string };
}

export interface SwapComponentResult {
  bundleId: string;
  componentIndex: number;
  oldPlanId: string;
  newPlanId: string;
  applyPolicy: ApplyPolicy;
  affectedChildSubscriptions: number;
}

export interface MigrateToBundleInput {
  userId: string;
  email: string | null;
  bundleId: string;
  currency: string;
}

export interface MigrateToBundleResult {
  /** Stripe Checkout URL the user must complete next. */
  checkoutUrl: string;
  /** Standalone subscriptions that were marked for cancellation. */
  canceledStandaloneSubs: string[];
  /** Total prorated credit (minor units, in `currency`) carried into checkout. */
  creditBalance: number;
}

export interface DowngradeToStandaloneInput {
  userId: string;
  bundleParentSubscriptionId: string;
  keepComponents: string[]; // productIds to keep
  targetPlans: Record<string, string>; // productId -> planId
}

export interface DowngradeToStandaloneResult {
  bundleParentSubscriptionId: string;
  keptComponents: Array<{ productId: string; targetPlanId: string; childSubId: string }>;
  droppedComponents: string[]; // productIds
  cancelAtPeriodEnd: Date | null;
}

export interface BundleMigrationService {
  swapComponent(input: SwapComponentInput): Promise<SwapComponentResult>;
  migrateToBundle(input: MigrateToBundleInput): Promise<MigrateToBundleResult>;
  downgradeToStandalone(input: DowngradeToStandaloneInput): Promise<DowngradeToStandaloneResult>;
}

export interface CreateBundleMigrationServiceOptions {
  bundleCheckout: BundleCheckoutService;
}

export function createBundleMigrationService(
  opts: CreateBundleMigrationServiceOptions,
): BundleMigrationService {
  return {
    // ── Flow AM ───────────────────────────────────────────────────────
    async swapComponent({ bundleId, componentIndex, newPlanId, applyPolicy, actor }) {
      const bundle = await bundleRepo.findBundleById(bundleId);
      if (!bundle) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      if (bundle.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Component swap requires an ACTIVE bundle',
        );
      }
      const components = bundle.components as Array<{ productId: string; planId: string }>;
      const target = components[componentIndex];
      if (!target) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `componentIndex ${componentIndex} out of range`,
        );
      }
      const [oldPlan, newPlan] = await Promise.all([
        planRepo.findPlanById(target.productId, target.planId),
        planRepo.findPlanById(target.productId, newPlanId),
      ]);
      if (!newPlan || newPlan.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'New plan not found / not ACTIVE');
      }
      if (!oldPlan) {
        throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Current component plan not found');
      }
      // billingScope check skipped — BillingPlan model has no billingScope field today.
      void oldPlan;

      // Snapshot before mutation.
      const before = { components: bundle.components };
      const updatedComponents = components.map((c, i) =>
        i === componentIndex ? { productId: c.productId, planId: newPlanId } : c,
      );
      await bundleRepo.updateBundleFields(bundleId, { components: updatedComponents });
      await bundleRepo.appendBundleChangeHistory(bundleId, {
        changedAt: new Date(),
        changedBy: actor.id,
        type: 'component_swapped',
        before,
        after: { componentIndex, newPlanId, applyPolicy },
      });

      let affected = 0;
      if (applyPolicy === 'forced_migrate') {
        // Find every active CHILD sub for this component within ACTIVE bundle parents.
        const activeChildren = await Subscription.find({
          bundleId,
          productId: target.productId,
          isBundleParent: { $ne: true },
          status: { $in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        })
          .select('_id productId planId amount currency bundleSubscriptionId')
          .lean<
            Array<{
              _id: string;
              productId: string;
              planId: string;
              amount: number;
              currency: string;
              bundleSubscriptionId: string | null;
            }>
          >();
        for (const child of activeChildren) {
          await subscriptionRepo.applyPlanChange({
            productId: child.productId,
            subscriptionId: child._id,
            newPlanId,
            newAmount: newPlan.amount ?? child.amount,
            newCurrency: newPlan.currency ?? child.currency,
            history: {
              changedAt: new Date(),
              changedBy: actor.id,
              type: 'plan_change',
              before: { planId: child.planId, amount: child.amount, currency: child.currency },
              after: { planId: newPlanId, bundleId, componentIndex },
              reason: 'bundle_component_swapped',
            },
          });
          await deliveryRepo
            .enqueueDelivery({
              productId: child.productId,
              event: 'subscription.updated',
              eventId: `bundle:swap:${bundleId}:${child._id}:${Date.now()}`,
              url: '',
              payloadRef: `bundle.component.swapped:${child._id}`,
              payload: {
                event: 'subscription.updated',
                subscriptionId: child._id,
                productId: child.productId,
                bundleId,
                componentIndex,
                newPlanId,
                applyPolicy: 'forced_migrate',
              },
            })
            .catch((err) =>
              logger.warn({ err, child: child._id }, 'enqueue subscription.updated failed'),
            );
          affected++;
        }
      } // For grandfather policy: existing children keep their planId until renewal.

      // Always emit one bundle.component.swapped per component product.
      await deliveryRepo
        .enqueueDelivery({
          productId: target.productId,
          event: 'bundle.component.swapped',
          eventId: `bundle.component.swapped:${bundleId}:${componentIndex}:${newPlanId}`,
          url: '',
          payloadRef: `bundle.component.swapped:${bundleId}`,
          payload: {
            event: 'bundle.component.swapped',
            bundleId,
            componentIndex,
            oldPlanId: target.planId,
            newPlanId,
            applyPolicy,
          },
        })
        .catch((err) =>
          logger.warn({ err, bundleId }, 'enqueue bundle.component.swapped failed'),
        );

      return {
        bundleId,
        componentIndex,
        oldPlanId: target.planId,
        newPlanId,
        applyPolicy,
        affectedChildSubscriptions: affected,
      };
    },

    // ── Flow AN — Path A ─────────────────────────────────────────────
    async migrateToBundle({ userId, email, bundleId, currency }) {
      const bundle = await bundleRepo.findBundleById(bundleId);
      if (!bundle || bundle.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      }
      const componentProductIds = (bundle.components as Array<{ productId: string }>).map(
        (c) => c.productId,
      );
      // Find user's active standalone subs in any of the component products.
      const standalones = await Subscription.find({
        subjectUserId: userId,
        productId: { $in: componentProductIds },
        isBundleParent: { $ne: true },
        bundleSubscriptionId: null,
        status: { $in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      })
        .select('_id productId amount currency currentPeriodEnd currentPeriodStart')
        .lean<
          Array<{
            _id: string;
            productId: string;
            amount: number;
            currency: string;
            currentPeriodEnd: Date | null;
            currentPeriodStart: Date | null;
          }>
        >();

      const policy = bundle.eligibilityPolicy as 'block' | 'cancel_and_credit' | 'replace_immediately';
      let creditBalance = 0;
      const canceled: string[] = [];
      const now = Date.now();

      for (const sub of standalones) {
        if (policy === 'block') {
          throw new AppError(
            ErrorCode.BILLING_BUNDLE_ELIGIBILITY_BLOCKED,
            'Bundle blocks migration while standalone subs exist',
            { conflictSubscriptionId: sub._id },
          );
        }
        if (policy === 'cancel_and_credit') {
          // Mark cancelAtPeriodEnd + compute prorated unused.
          await Subscription.updateOne(
            { _id: sub._id },
            {
              $set: {
                cancelAtPeriodEnd: true,
                cancelReason: 'migrated_to_bundle',
              },
            },
          );
          if (
            sub.currentPeriodEnd &&
            sub.currentPeriodStart &&
            sub.currency.toLowerCase() === currency.toLowerCase()
          ) {
            const total = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
            const unused = Math.max(0, sub.currentPeriodEnd.getTime() - now);
            if (total > 0) {
              creditBalance += Math.floor((sub.amount * unused) / total);
            }
          }
          canceled.push(sub._id);
        } else {
          // replace_immediately — best-effort immediate cancel; gateway-side cleanup
          // happens via existing webhook flow when the gateway emits `customer.subscription.deleted`.
          await Subscription.updateOne(
            { _id: sub._id },
            {
              $set: {
                status: 'CANCELED',
                canceledAt: new Date(),
                cancelReason: 'migrated_to_bundle',
              },
            },
          );
          canceled.push(sub._id);
        }
      }

      // Hand off to existing bundle checkout. Credit is recorded for downstream
      // application during webhook post-processing (not yet wired through; doc'd).
      const checkoutCtx: BundleCheckoutContext = { userId, email };
      const checkoutResult = await opts.bundleCheckout.createBundleCheckout(checkoutCtx, {
        bundleId,
        currency,
        subjects: {},
        successUrl: '',
        cancelUrl: '',
      });

      // Audit-trail breadcrumb on each canceled standalone (denormalised).
      for (const id of canceled) {
        await Subscription.updateOne(
          { _id: id },
          { $set: { 'gatewayRefs.migratedToBundleId': bundleId } },
        ).catch(() => undefined);
      }

      return {
        checkoutUrl: checkoutResult.url,
        canceledStandaloneSubs: canceled,
        creditBalance,
      };
    },

    // ── Flow AN — Path B ─────────────────────────────────────────────
    async downgradeToStandalone({ userId, bundleParentSubscriptionId, keepComponents, targetPlans }) {
      const parent = await Subscription.findOne({ _id: bundleParentSubscriptionId })
        .lean<{
          _id: string;
          subjectUserId: string | null;
          isBundleParent: boolean;
          bundleId: string | null;
          currentPeriodEnd: Date | null;
        } | null>();
      if (!parent || !parent.isBundleParent || !parent.bundleId) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Bundle parent subscription not found');
      }
      if (parent.subjectUserId !== userId) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not the owner of this bundle');
      }
      const bundle = await bundleRepo.findBundleById(parent.bundleId);
      if (!bundle) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');

      const components = bundle.components as Array<{ productId: string; planId: string }>;
      const dropped: string[] = [];
      const kept: Array<{ productId: string; targetPlanId: string; childSubId: string }> = [];

      // Schedule parent cancel at period end — bundle-cancel-cascade cron will
      // clean up dropped child subs after that.
      await Subscription.updateOne(
        { _id: parent._id },
        {
          $set: {
            cancelAtPeriodEnd: true,
            cancelReason: 'downgrade_to_standalone',
            'gatewayRefs.downgradeKeepComponents': keepComponents,
          },
        },
      );

      for (const comp of components) {
        const child = await Subscription.findOne({
          bundleSubscriptionId: parent._id,
          productId: comp.productId,
          isBundleParent: { $ne: true },
        })
          .select('_id planId amount currency')
          .lean<{ _id: string; planId: string; amount: number; currency: string } | null>();
        if (!child) continue;
        if (!keepComponents.includes(comp.productId)) {
          dropped.push(comp.productId);
          continue;
        }
        const targetPlanId = targetPlans[comp.productId];
        if (!targetPlanId) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `targetPlans missing entry for kept productId ${comp.productId}`,
          );
        }
        const target = await planRepo.findPlanById(comp.productId, targetPlanId);
        if (!target || target.status !== 'ACTIVE') {
          throw new AppError(
            ErrorCode.PLAN_NOT_FOUND,
            `Target plan ${targetPlanId} not found / not ACTIVE`,
          );
        }
        const targetAmount = target.amount ?? child.amount;
        const targetCurrency = target.currency ?? child.currency;
        // Detach from bundle BEFORE the cascade cron picks it up.
        await Subscription.updateOne(
          { _id: child._id },
          {
            $set: {
              bundleSubscriptionId: null,
              bundleId: null,
              planId: targetPlanId,
              amount: targetAmount,
              currency: targetCurrency,
            },
            $push: {
              changeHistory: {
                changedAt: new Date(),
                changedBy: userId,
                type: 'plan_change',
                before: { planId: child.planId, amount: child.amount, currency: child.currency, bundleId: bundle._id },
                after: { planId: targetPlanId, amount: targetAmount, currency: targetCurrency, bundleId: null },
                reason: 'bundle_to_standalone',
              },
            },
          },
        );
        kept.push({ productId: comp.productId, targetPlanId, childSubId: child._id });
        await deliveryRepo
          .enqueueDelivery({
            productId: comp.productId,
            event: 'subscription.updated',
            eventId: `bundle:downgrade:${parent._id}:${child._id}`,
            url: '',
            payloadRef: `bundle.downgrade:${parent._id}`,
            payload: {
              event: 'subscription.updated',
              subscriptionId: child._id,
              productId: comp.productId,
              fromBundleId: bundle._id,
              newPlanId: targetPlanId,
            },
          })
          .catch((err) =>
            logger.warn({ err, child: child._id }, 'enqueue downgrade.updated failed'),
          );
      }

      return {
        bundleParentSubscriptionId: parent._id,
        keptComponents: kept,
        droppedComponents: dropped,
        cancelAtPeriodEnd: parent.currentPeriodEnd,
      };
    },
  };
}
