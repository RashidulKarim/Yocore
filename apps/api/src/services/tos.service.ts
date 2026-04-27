/**
 * Terms-of-Service / Privacy-Policy gate (V1.0-B / B-05).
 *
 * - `getCurrent()`     → returns the published current TosVersion docs.
 * - `assertAccepted()` → throws `TOS_NOT_ACCEPTED` unless the supplied
 *                        version strings match the current ones (per type).
 *
 * No external state; pulls directly from the `tosVersions` collection.
 * Cheap enough to call inline; if hot-path sensitivity emerges we can
 * memoise per process for ~30s and invalidate via Redis pub/sub.
 */
import { TosVersion, type TosVersionDoc } from '../db/models/TosVersion.js';
import { AppError, ErrorCode } from '../lib/errors.js';

export interface CurrentTos {
  termsOfService: TosVersionDoc | null;
  privacyPolicy: TosVersionDoc | null;
}

export async function getCurrent(): Promise<CurrentTos> {
  const [tos, privacy] = await Promise.all([
    TosVersion.findOne({ type: 'terms_of_service', isCurrent: true }).lean<TosVersionDoc>(),
    TosVersion.findOne({ type: 'privacy_policy', isCurrent: true }).lean<TosVersionDoc>(),
  ]);
  return { termsOfService: tos, privacyPolicy: privacy };
}

/**
 * Throws TOS_NOT_ACCEPTED if either version doesn't match the current
 * published version. If no current version is published yet for a given
 * type, that type is treated as "no gate required" — this keeps local
 * dev / staging unblocked when ToS hasn't been seeded.
 */
export async function assertAccepted(input: {
  acceptedTosVersion: string;
  acceptedPrivacyVersion: string;
}): Promise<{ tosVersion: string; privacyVersion: string }> {
  const current = await getCurrent();

  if (current.termsOfService && current.termsOfService.version !== input.acceptedTosVersion) {
    throw new AppError(
      ErrorCode.TOS_NOT_ACCEPTED,
      'Terms of Service version is out of date',
      { current: current.termsOfService.version, supplied: input.acceptedTosVersion },
    );
  }
  if (current.privacyPolicy && current.privacyPolicy.version !== input.acceptedPrivacyVersion) {
    throw new AppError(
      ErrorCode.TOS_NOT_ACCEPTED,
      'Privacy Policy version is out of date',
      { current: current.privacyPolicy.version, supplied: input.acceptedPrivacyVersion },
    );
  }

  return {
    tosVersion: input.acceptedTosVersion,
    privacyVersion: input.acceptedPrivacyVersion,
  };
}
