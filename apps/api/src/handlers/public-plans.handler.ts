/**
 * Public plans handler — `GET /v1/products/:slug/plans`.
 *
 * Returns ACTIVE + visibility:public plans only. Cached 5 minutes via the
 * plan service (Redis key `cache:plans:<productId>`). No auth required —
 * meant to power public pricing pages.
 */
import type { Request, Response, RequestHandler } from 'express';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';

export interface PublicPlansHandlers {
  listPublicPlans: RequestHandler;
}

export function publicPlansHandlerFactory(ctx: AppContext): PublicPlansHandlers {
  return {
    listPublicPlans: asyncHandler(async (req: Request, res: Response) => {
      const slug = (req.params['slug'] ?? '').trim().toLowerCase();
      const plans = await ctx.plan.listPublic(slug);
      // Hint downstream caches; matches our 5-min TTL.
      res.set('Cache-Control', 'public, max-age=300');
      // Trim each plan to the public projection (omit gateway price ids etc.).
      const publicPlans = plans.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        isFree: p.isFree,
        amount: p.amount,
        currency: p.currency,
        interval: p.interval,
        intervalCount: p.intervalCount,
        trialDays: p.trialDays,
        limits: p.limits,
        seatBased: p.seatBased,
        perSeatAmount: p.perSeatAmount,
        includedSeats: p.includedSeats,
      }));
      res.status(200).json({ plans: publicPlans });
    }),
  };
}
