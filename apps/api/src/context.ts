/**
 * Application "context" — holds the long-lived dependencies wired together
 * at boot. Created once via `createAppContext()` (production) or via factories
 * in tests so each test can swap in mocks/in-memory primitives.
 *
 * Why not a DI container: the surface is small enough that an explicit object
 * is cheaper to read than a framework. Handlers receive the context via a
 * factory: `authHandlerFactory(ctx)` returns the express route handlers.
 */
import type { Redis } from 'ioredis';
import { JwtKeyring } from './lib/jwt-keyring.js';
import { jwtKeyringLoader } from './repos/jwt-key.repo.js';
import { createSessionStore } from './services/session-store.service.js';
import { createAuthService, type AuthService } from './services/auth.service.js';
import { createSignupService, type SignupService } from './services/signup.service.js';
import {
  createVerifyEmailService,
  type VerifyEmailService,
} from './services/verify-email.service.js';
import {
  createConfirmJoinService,
  type ConfirmJoinService,
} from './services/confirm-join.service.js';
import {
  createPasswordResetService,
  type PasswordResetService,
} from './services/password-reset.service.js';
import {
  createEmailChangeService,
  type EmailChangeService,
} from './services/email-change.service.js';
import {
  createEmailPrefsService,
  type EmailPrefsService,
} from './services/email-prefs.service.js';
import { createPkceService, type PkceService } from './services/pkce.service.js';
import {
  createPermissionService,
  type PermissionService,
} from './services/permission.service.js';
import {
  createWorkspaceService,
  type WorkspaceService,
} from './services/workspace.service.js';
import { createMemberService, type MemberService } from './services/member.service.js';
import {
  createInvitationService,
  type InvitationService,
} from './services/invitation.service.js';
import { createProductService, type ProductService } from './services/product.service.js';
import { createGatewayService, type GatewayService } from './services/gateway.service.js';
import { createPlanService, type PlanService } from './services/plan.service.js';
import {
  createCheckoutService,
  type CheckoutService,
  type StripeApi,
} from './services/checkout.service.js';
import {
  createStripeWebhookService,
  type StripeWebhookService,
  type StripeWebhookApi,
} from './services/stripe-webhook.service.js';
import {
  createSslcommerzWebhookService,
  type SslcommerzWebhookService,
} from './services/sslcommerz-webhook.service.js';
import type { SslcommerzGatewayApi } from './services/sslcommerz-api.js';
import { createTrialService, type TrialService } from './services/trial.service.js';
import {
  createChangePlanService,
  type ChangePlanService,
  type StripePlanApi,
} from './services/change-plan.service.js';
import {
  createSeatChangeService,
  type SeatChangeService,
  type StripeSeatApi,
} from './services/seat-change.service.js';
import {
  createPauseResumeService,
  type PauseResumeService,
  type StripePauseApi,
} from './services/pause-resume.service.js';
import {
  createCouponService,
  type CouponService,
  type StripeCouponApi,
} from './services/coupon.service.js';
import {
  createRefundService,
  type RefundService,
  type StripeRefundApi,
} from './services/refund.service.js';
import {
  createGatewayMigrationService,
  type GatewayMigrationService,
  type StripeCancelApi,
} from './services/gateway-migration.service.js';
import {
  createGraceService,
  type GraceService,
} from './services/grace.service.js';
import {
  createInvoiceSyncService,
  type InvoiceSyncService,
} from './services/invoice-sync.service.js';
import {
  createTaxProfileService,
  type TaxProfileService,
} from './services/tax-profile.service.js';
import { createBundleService, type BundleService, type StripeBundlePriceApi } from './services/bundle.service.js';
import { createBundleCheckoutService, type BundleCheckoutService } from './services/bundle-checkout.service.js';
import { createBundleCascadeService, type BundleCascadeService } from './services/bundle-cascade.service.js';
import {
  createWebhookDeliveryService,
  type WebhookDeliveryService,
  type DeliveryHttpClient,
} from './services/webhook-delivery.service.js';
import {
  createWebhookArchiveService,
  type WebhookArchiveService,
} from './services/webhook-archive.service.js';
import { createAdminOpsService, type AdminOpsService } from './services/admin-ops.service.js';
import {
  createJwtRotationService,
  type JwtRotationService,
  KEYRING_RELOAD_CHANNEL,
} from './services/jwt-rotation.service.js';
import {
  createSelfDeletionService,
  type SelfDeletionService,
} from './services/self-deletion.service.js';
import {
  createDataExportService,
  type DataExportService,
} from './services/data-export.service.js';
import {
  createEmailDeliverabilityService,
  type EmailDeliverabilityService,
} from './services/email-deliverability.service.js';
import {
  createBundleMigrationService,
  type BundleMigrationService,
} from './services/bundle-migration.service.js';
import { auditLogRepo } from './repos/audit-log.repo.js';
import { env } from './config/env.js';
import { getRedis } from './config/redis.js';
import type { SessionStore } from './middleware/jwt-auth.js';
import type { AuditLogStore } from './middleware/audit-log.js';

export interface AppContext {
  redis: Redis;
  keyring: JwtKeyring;
  sessionStore: SessionStore & {
    markActive(jti: string, ttl: number): Promise<void>;
    markRevoked(jti: string): Promise<void>;
  };
  auditStore: AuditLogStore;
  auth: AuthService;
  signup: SignupService;
  verifyEmail: VerifyEmailService;
  confirmJoin: ConfirmJoinService;
  passwordReset: PasswordResetService;
  emailChange: EmailChangeService;
  emailPrefs: EmailPrefsService;
  pkce: PkceService;
  permission: PermissionService;
  workspace: WorkspaceService;
  member: MemberService;
  invitation: InvitationService;
  product: ProductService;
  gateway: GatewayService;
  plan: PlanService;
  checkout: CheckoutService;
  stripeWebhook: StripeWebhookService;
  sslcommerzWebhook: SslcommerzWebhookService;
  trial: TrialService;
  changePlan: ChangePlanService;
  seatChange: SeatChangeService;
  pauseResume: PauseResumeService;
  coupon: CouponService;
  refund: RefundService;
  gatewayMigration: GatewayMigrationService;
  grace: GraceService;
  invoiceSync: InvoiceSyncService;
  taxProfile: TaxProfileService;
  bundle: BundleService;
  bundleCheckout: BundleCheckoutService;
  bundleCascade: BundleCascadeService;
  webhookDelivery: WebhookDeliveryService;
  webhookArchive: WebhookArchiveService;
  adminOps: AdminOpsService;
  jwtRotation: JwtRotationService;
  gdprDeletion: SelfDeletionService;
  dataExport: DataExportService;
  emailDeliverability: EmailDeliverabilityService;
  bundleMigration: BundleMigrationService;
}

export interface CreateAppContextOptions {
  /** Override Redis (tests / ioredis-mock). */
  redis?: Redis;
  /** Override the keyring loader (tests pass a fixture). */
  keyring?: JwtKeyring;
  /** Override the audit store (tests pass an in-memory impl). */
  auditStore?: AuditLogStore;
  /** Override gateway verifier (tests skip real HTTP). */
  gatewayVerify?: import('./services/gateway.service.js').VerifyFn;
  /** Override Stripe price creator (tests skip real HTTP). */
  stripeCreatePrice?: import('./services/plan.service.js').StripePriceCreateFn;
  /** Override Stripe checkout/customer API (tests). */
  stripeApi?: StripeApi;
  /** Override Stripe webhook helper API (tests). */
  stripeWebhookApi?: StripeWebhookApi;
  /** Override SSLCommerz combined gateway adapter (tests). */
  sslcommerzApi?: SslcommerzGatewayApi;
  /** Override clock for webhook timestamp tolerance (tests). */
  webhookNow?: () => Date;
  /** Override Stripe plan-change API (tests). */
  stripePlanApi?: StripePlanApi;
  /** Override Stripe seat API (tests). */
  stripeSeatApi?: StripeSeatApi;
  /** Override Stripe pause/resume API (tests). */
  stripePauseApi?: StripePauseApi;
  /** Override Stripe coupon API (tests). */
  stripeCouponApi?: StripeCouponApi;
  /** Override Stripe refund API (tests). */
  stripeRefundApi?: StripeRefundApi;
  /** Override Stripe cancel-at-period-end API (tests — used by gateway migration). */
  stripeCancelApi?: StripeCancelApi;
  /** Override Stripe bundle-price API (tests). */
  stripeBundlePriceApi?: StripeBundlePriceApi;
  /** Override outbound webhook HTTP client (tests). */
  webhookHttpClient?: DeliveryHttpClient;
}

export async function createAppContext(opts: CreateAppContextOptions = {}): Promise<AppContext> {
  const redis = opts.redis ?? getRedis();
  const keyring = opts.keyring ?? new JwtKeyring(jwtKeyringLoader);
  if (!opts.keyring) await keyring.reload();
  const sessionStore = createSessionStore({ redis });
  const auditStore = opts.auditStore ?? auditLogRepo;

  const auth = createAuthService({
    redis,
    keyring,
    markSessionActive: (jti, ttl) => sessionStore.markActive(jti, ttl),
    markSessionRevoked: (jti) => sessionStore.markRevoked(jti),
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSecondsRemember: env.JWT_REFRESH_TTL_SECONDS,
    refreshTtlSecondsNoRemember: env.JWT_REFRESH_TTL_NO_REMEMBER_SECONDS,
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });

  const signup = createSignupService({
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });

  const verifyEmail = createVerifyEmailService({ auth });
  const confirmJoin = createConfirmJoinService({ auth });
  const passwordReset = createPasswordResetService({
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });
  const emailChange = createEmailChangeService({
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });
  const emailPrefs = createEmailPrefsService({
    unsubscribeSecret: env.EMAIL_UNSUBSCRIBE_SECRET,
  });
  const pkce = createPkceService({ auth });

  const permission = createPermissionService({ redis });
  const workspace = createWorkspaceService({
    redis,
    keyring,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    defaultMaxWorkspacesPerOwner: env.WORKSPACE_DEFAULT_MAX_PER_OWNER,
    markSessionActive: (jti, ttl) => sessionStore.markActive(jti, ttl),
    markSessionRevoked: (jti) => sessionStore.markRevoked(jti),
    invalidatePermissions: (productId, userId, workspaceId) =>
      permission.invalidate(productId, userId, workspaceId),
  });
  const member = createMemberService({
    invalidatePermissions: (productId, userId, workspaceId) =>
      permission.invalidate(productId, userId, workspaceId),
  });
  const invitation = createInvitationService({
    auth,
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
    invalidatePermissions: (productId, userId, workspaceId) =>
      permission.invalidate(productId, userId, workspaceId),
  });

  const product = createProductService();
  const gateway = createGatewayService(
    opts.gatewayVerify ? { verify: opts.gatewayVerify } : {},
  );
  const plan = createPlanService({
    redis,
    ...(opts.stripeCreatePrice ? { stripeCreatePrice: opts.stripeCreatePrice } : {}),
  });
  const checkout = createCheckoutService({
    redis,
    ...(opts.stripeApi ? { stripeApi: opts.stripeApi } : {}),
    ...(opts.sslcommerzApi ? { sslcommerzApi: opts.sslcommerzApi } : {}),
  });
  const invoiceSync = createInvoiceSyncService();
  // stripeWebhook is created below (after bundleCheckout) so it can dispatch
  // bundle checkout.session.completed events to the bundle handler.
  const sslcommerzWebhook = createSslcommerzWebhookService({
    ...(opts.sslcommerzApi ? { sslcommerzApi: opts.sslcommerzApi } : {}),
  });
  const trial = createTrialService({
    auditStore,
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });
  const changePlan = createChangePlanService({
    ...(opts.stripePlanApi ? { stripePlanApi: opts.stripePlanApi } : {}),
  });
  const seatChange = createSeatChangeService({
    ...(opts.stripeSeatApi ? { stripeSeatApi: opts.stripeSeatApi } : {}),
  });
  const pauseResume = createPauseResumeService({
    ...(opts.stripePauseApi ? { stripePauseApi: opts.stripePauseApi } : {}),
  });
  const coupon = createCouponService({
    ...(opts.stripeCouponApi ? { stripeCouponApi: opts.stripeCouponApi } : {}),
  });
  const refund = createRefundService({
    ...(opts.stripeRefundApi ? { stripeRefundApi: opts.stripeRefundApi } : {}),
  });
  const gatewayMigration = createGatewayMigrationService({
    checkout,
    ...(opts.stripeCancelApi ? { stripeCancelApi: opts.stripeCancelApi } : {}),
  });
  const grace = createGraceService({
    auditStore,
    defaultFromAddress: env.EMAIL_FROM_DEFAULT,
  });
  const taxProfile = createTaxProfileService();

  const bundle = createBundleService({
    ...(opts.stripeBundlePriceApi ? { stripeBundlePriceApi: opts.stripeBundlePriceApi } : {}),
  });
  const bundleCheckout = createBundleCheckoutService({
    redis,
    ...(opts.stripeApi ? { stripeApi: opts.stripeApi } : {}),
  });
  const bundleCascade = createBundleCascadeService({ auditStore });
  const webhookDelivery = createWebhookDeliveryService({
    ...(opts.webhookHttpClient ? { httpClient: opts.webhookHttpClient } : {}),
  });
  const adminOps = createAdminOpsService({ webhookDelivery });
  const jwtRotation = createJwtRotationService({
    redis,
    keyring,
    auditStore,
  });

  // Listen for keyring reload broadcasts from peer pods.
  if (!opts.keyring) {
    const sub = redis.duplicate();
    sub
      .subscribe(KEYRING_RELOAD_CHANNEL)
      .then(() => {
        sub.on('message', () => {
          void keyring.reload().catch(() => undefined);
        });
      })
      .catch(() => {
        /* non-fatal */
      });
  }

  // Re-create stripeWebhook now that bundleCheckout exists, so it can dispatch
  // bundle checkout.session.completed events to the bundle handler.
  const stripeWebhookWithBundle = createStripeWebhookService({
    ...(opts.stripeWebhookApi ? { stripeApi: opts.stripeWebhookApi } : {}),
    ...(opts.webhookNow ? { now: opts.webhookNow } : {}),
    invoiceSync,
    bundleCheckout,
  });
  return {
    redis,
    keyring,
    sessionStore,
    auditStore,
    auth,
    signup,
    verifyEmail,
    confirmJoin,
    passwordReset,
    emailChange,
    emailPrefs,
    pkce,
    permission,
    workspace,
    member,
    invitation,
    product,
    gateway,
    plan,
    checkout,
    stripeWebhook: stripeWebhookWithBundle,
    sslcommerzWebhook,
    trial,
    changePlan,
    seatChange,
    pauseResume,
    coupon,
    refund,
    gatewayMigration,
    grace,
    invoiceSync,
    taxProfile,
    bundle,
    bundleCheckout,
    bundleCascade,
    webhookDelivery,
    webhookArchive: createWebhookArchiveService(),
    adminOps,
    jwtRotation,
    gdprDeletion: createSelfDeletionService(),
    dataExport: createDataExportService({
      signingSecret: env.EMAIL_UNSUBSCRIBE_SECRET,
      defaultFromAddress: env.EMAIL_FROM_DEFAULT,
      publicBaseUrl: env.PUBLIC_API_BASE_URL,
    }),
    emailDeliverability: createEmailDeliverabilityService({ auditStore }),
    bundleMigration: createBundleMigrationService({ bundleCheckout }),
  };
}
