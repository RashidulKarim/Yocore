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
  const stripeWebhook = createStripeWebhookService({
    ...(opts.stripeWebhookApi ? { stripeApi: opts.stripeWebhookApi } : {}),
    ...(opts.webhookNow ? { now: opts.webhookNow } : {}),
  });
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
    stripeWebhook,
    sslcommerzWebhook,
    trial,
    changePlan,
  };
}
