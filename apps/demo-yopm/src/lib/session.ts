/**
 * 👉 In-memory session store for the demo.
 * Keyed by an opaque cookie ('yopm_sid'). Stores the YoCore tokens + a few
 * convenience fields. NOT for production — a real product would store these
 * in Redis with HttpOnly+Secure cookies and CSRF protection.
 */
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';

export interface DemoSession {
  sid: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  userId: string;
  productId: string | null;
  workspaceId?: string | undefined;
  email?: string | undefined;
  /** Pending MFA challenge id (after first signin leg). */
  mfaChallengeId?: string | undefined;
  mfaEmail?: string | undefined;
}

const COOKIE = 'yopm_sid';
const store = new Map<string, DemoSession>();

export function attachSession(req: Request, res: Response, next: NextFunction): void {
  let sid = req.cookies?.[COOKIE] as string | undefined;
  if (!sid) {
    sid = randomBytes(18).toString('hex');
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', path: '/' });
  }
  (req as Request & { sid: string }).sid = sid;
  next();
}

export function getSession(req: Request): DemoSession | undefined {
  const sid = (req as Request & { sid?: string }).sid;
  return sid ? store.get(sid) : undefined;
}

export function setSession(req: Request, patch: Partial<DemoSession>): DemoSession {
  const sid = (req as Request & { sid: string }).sid;
  const prev = store.get(sid) ?? ({ sid } as DemoSession);
  const next = { ...prev, ...patch, sid };
  store.set(sid, next);
  return next;
}

export function clearSession(req: Request): void {
  const sid = (req as Request & { sid?: string }).sid;
  if (sid) store.delete(sid);
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const s = getSession(req);
  if (!s?.accessToken) {
    res.redirect(302, '/signin');
    return;
  }
  next();
}
