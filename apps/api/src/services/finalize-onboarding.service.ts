/**
 * Finalize-onboarding service — Flow F12.
 *
 * Runs once per (user × product). Creates the user's first workspace,
 * adds them as OWNER, flips `productUsers.onboarded:false → true`, and
 * applies any optional profile preferences (timezone, locale, etc.).
 *
 * Pre-conditions enforced here (defence in depth — handler also checks JWT):
 *   - user must exist + be email-verified (AUTH_EMAIL_NOT_VERIFIED otherwise)
 *   - productUser must exist (NOT_FOUND otherwise)
 *   - productUser.onboarded must be false (AUTH_ONBOARDING_ALREADY_COMPLETE)
 *   - workspace slug must not collide within the product (RESOURCE_CONFLICT)
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as workspaceMemberRepo from '../repos/workspace-member.repo.js';
import * as roleRepo from '../repos/role.repo.js';

/**
 * Built-in OWNER role identifiers. These platform rows are seeded on demand
 * via `roleRepo.ensurePlatformRoles` so we never reference a non-existent id.
 */
const OWNER_ROLE_SLUG = 'OWNER';

export interface FinalizeOnboardingInput {
  userId: string;
  productId: string;
  workspaceName: string;
  workspaceSlug?: string;
  timezone?: string;
  locale?: string;
  dateFormat?: string;
  timeFormat?: '12h' | '24h';
  displayName?: string;
}

export interface FinalizeOnboardingOutcome {
  workspace: { id: string; name: string; slug: string };
  productUser: { onboarded: true };
}

/** Best-effort URL-safe slug derived from a free-form name. */
export function deriveSlug(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length >= 2 ? cleaned.slice(0, 64) : 'workspace';
}

export async function finalizeOnboarding(
  input: FinalizeOnboardingInput,
): Promise<FinalizeOnboardingOutcome> {
  const user = await userRepo.findUserById(input.userId);
  if (!user) throw new AppError(ErrorCode.USER_NOT_FOUND, 'User not found');
  if (!user.emailVerified) {
    throw new AppError(ErrorCode.AUTH_EMAIL_NOT_VERIFIED, 'Email not verified');
  }

  const pu = await productUserRepo.findByUserAndProduct(input.productId, input.userId);
  if (!pu) throw new AppError(ErrorCode.NOT_FOUND, 'Product user not found');
  if (pu.onboarded) {
    throw new AppError(
      ErrorCode.AUTH_ONBOARDING_ALREADY_COMPLETE,
      'Onboarding already completed',
    );
  }

  const desiredSlug = (input.workspaceSlug ?? deriveSlug(input.workspaceName)).slice(0, 64);
  if (await workspaceRepo.slugExists(input.productId, desiredSlug)) {
    throw new AppError(ErrorCode.RESOURCE_CONFLICT, 'Workspace slug already taken');
  }

  const workspace = await workspaceRepo.createWorkspace({
    productId: input.productId,
    name: input.workspaceName,
    slug: desiredSlug,
    ownerUserId: input.userId,
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });

  const platformRoles = await roleRepo.ensurePlatformRoles(input.productId);
  const ownerRole = platformRoles.OWNER;

  await workspaceMemberRepo.createMember({
    workspaceId: workspace._id,
    productId: input.productId,
    userId: input.userId,
    roleId: ownerRole._id,
    roleSlug: OWNER_ROLE_SLUG,
    addedBy: null,
  });

  await productUserRepo.updateProfile(input.productId, input.userId, {
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.dateFormat !== undefined ? { dateFormat: input.dateFormat } : {}),
    ...(input.timeFormat !== undefined ? { timeFormat: input.timeFormat } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
  });

  const flipped = await productUserRepo.markOnboarded(input.productId, input.userId);
  if (!flipped) {
    // Lost the race with another concurrent finalise — surface as conflict.
    throw new AppError(
      ErrorCode.AUTH_ONBOARDING_ALREADY_COMPLETE,
      'Onboarding already completed',
    );
  }

  return {
    workspace: { id: workspace._id, name: workspace.name, slug: workspace.slug },
    productUser: { onboarded: true },
  };
}
