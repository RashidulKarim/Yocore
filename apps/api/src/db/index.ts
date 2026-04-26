/**
 * Mongoose model registry.
 *
 * Importing this module registers every model with Mongoose. Repos should import
 * the named export they need (e.g. `import { User } from '@/db/models/User'`)
 * — this barrel exists for db bootstrap, tests, and migration scripts.
 */

export { newId, idDefault } from './id.js';

// Identity / auth
export { User, type UserDoc } from './models/User.js';
export { ProductUser, type ProductUserDoc } from './models/ProductUser.js';
export { Session, type SessionDoc } from './models/Session.js';
export { AuthToken, type AuthTokenDoc } from './models/AuthToken.js';
export { MfaFactor, type MfaFactorDoc } from './models/MfaFactor.js';
export { MfaRecoveryRequest, type MfaRecoveryRequestDoc } from './models/MfaRecoveryRequest.js';
export { JwtSigningKey, type JwtSigningKeyDoc } from './models/JwtSigningKey.js';

// Products / workspaces
export { Product, type ProductDoc } from './models/Product.js';
export { Workspace, type WorkspaceDoc } from './models/Workspace.js';
export { WorkspaceMember, type WorkspaceMemberDoc } from './models/WorkspaceMember.js';
export { Role, type RoleDoc } from './models/Role.js';
export { Invitation, type InvitationDoc } from './models/Invitation.js';

// Billing
export { BillingPlan, type BillingPlanDoc } from './models/BillingPlan.js';
export { Subscription, type SubscriptionDoc } from './models/Subscription.js';
export { PaymentGateway, type PaymentGatewayDoc } from './models/PaymentGateway.js';
export { Invoice, type InvoiceDoc } from './models/Invoice.js';
export { Coupon, type CouponDoc } from './models/Coupon.js';
export { CouponRedemption, type CouponRedemptionDoc } from './models/CouponRedemption.js';
export { Bundle, type BundleDoc } from './models/Bundle.js';
export { UsageRecord, type UsageRecordDoc } from './models/UsageRecord.js';
export { CustomerTaxProfile, type CustomerTaxProfileDoc } from './models/CustomerTaxProfile.js';
export { PaymentMethodCache, type PaymentMethodCacheDoc } from './models/PaymentMethodCache.js';

// Webhooks / cron / audit / email
export { WebhookDelivery, type WebhookDeliveryDoc } from './models/WebhookDelivery.js';
export {
  WebhookEventProcessed,
  type WebhookEventProcessedDoc,
} from './models/WebhookEventProcessed.js';
export { CronLock, type CronLockDoc } from './models/CronLock.js';
export { AuditLog, type AuditLogDoc } from './models/AuditLog.js';
export { AuditLogExportJob, type AuditLogExportJobDoc } from './models/AuditLogExportJob.js';
export { EmailQueue, type EmailQueueDoc } from './models/EmailQueue.js';
export { EmailEvent, type EmailEventDoc } from './models/EmailEvent.js';
export { IdempotencyKey, type IdempotencyKeyDoc } from './models/IdempotencyKey.js';
export { DataExportJob, type DataExportJobDoc } from './models/DataExportJob.js';
export { DeletionRequest, type DeletionRequestDoc } from './models/DeletionRequest.js';
export { TosVersion, type TosVersionDoc } from './models/TosVersion.js';
export { SuperAdminConfig, type SuperAdminConfigDoc } from './models/SuperAdminConfig.js';
