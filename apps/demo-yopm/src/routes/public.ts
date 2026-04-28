/**
 * Public routes (no session required):
 *   GET  /                  → landing page
 *   GET  /plans             → fetch & list public plans for productSlug
 *   GET  /signup            → form
 *   POST /signup            → POST /v1/auth/signup
 *   GET  /verify-email      → GET /v1/auth/verify-email?token=
 *   GET  /signin            → form
 *   POST /signin            → POST /v1/auth/signin (productSlug-scoped)
 *   POST /signin/mfa        → second leg with mfaCode
 *   GET  /forgot-password   → form
 *   POST /forgot-password   → POST /v1/auth/forgot-password
 *   GET  /reset-password    → form (with token in query)
 *   POST /reset-password    → POST /v1/auth/reset-password
 *   GET  /signout           → clear session, sign out
 *   GET  /accept-invite     → GET /v1/invitations/preview, then form
 *   POST /accept-invite     → POST /v1/invitations/accept-new (existing flow handled in /workspaces)
 */
import { Router, type Request, type Response } from 'express';
import { layout, jsonBlock, escape, flashFromQuery } from '../lib/views.js';
import { publicCall, describeError } from '../lib/api.js';
import { getSession, setSession, clearSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';

interface SigninSuccess {
  status: 'signed_in';
  userId: string;
  role: 'SUPER_ADMIN' | 'END_USER';
  productId: string | null;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: 'Bearer' };
}
interface SigninMfa {
  status: 'mfa_required';
  mfaChallengeId: string;
  factors: Array<'totp' | 'recovery_code'>;
}

export function publicRouter(cfg: DemoConfig): Router {
  const r = Router();

  r.get('/', (req: Request, res: Response) => {
    const sess = getSession(req);
    res.send(
      layout(
        'Home',
        `<div class="card">
          <h1>YoPM Demo</h1>
          <p class="muted">A reference product wired to YoCore at <code>${escape(cfg.yocoreBaseUrl)}</code> as <code>${escape(cfg.productSlug)}</code>.</p>
          <p>Use this app end-to-end to exercise every YoCore feature: plans, signup, MFA, workspaces, invitations, billing, bundles, GDPR exports, deletion.</p>
          <div class="row">
            <a class="btn" href="/plans">Browse plans →</a>
            ${sess?.accessToken ? '<a class="btn secondary" href="/account">Account</a>' : '<a class="btn secondary" href="/signin">Sign in</a>'}
          </div>
        </div>`,
        { session: sess, ...flashFromQuery(req) },
      ),
    );
  });

  // ── Plans (public) ───────────────────────────────────────────────────
  r.get('/plans', async (req, res) => {
    const result = await publicCall<{ plans?: unknown[] } | unknown[]>(
      cfg.yocoreBaseUrl,
      `/v1/products/${encodeURIComponent(cfg.productSlug)}/plans`,
    );
    const sess = getSession(req);
    if (!result.ok) {
      return res.send(
        layout('Plans', `<div class="card"><p>Failed to load plans: ${describeError(result)}</p></div>`, {
          session: sess,
          active: 'plans',
        }),
      );
    }
    const plans = (Array.isArray(result.body)
      ? result.body
      : (result.body as { plans?: unknown[] })?.plans) as Array<Record<string, unknown>> | undefined;
    const cards = (plans ?? [])
      .map((p) => {
        const id = String(p['id'] ?? '');
        const amount = Number(p['amount'] ?? 0) / 100;
        const cur = String(p['currency'] ?? 'usd').toUpperCase();
        const interval = String(p['interval'] ?? 'one_time');
        const trial = Number(p['trialDays'] ?? 0);
        return `<div class="card">
          <h3>${escape(p['name'])}</h3>
          <div class="muted">${escape(id)}</div>
          <p><b>${amount.toFixed(2)} ${escape(cur)}</b> / ${escape(interval)}${trial > 0 ? ` · ${trial}-day trial` : ''}</p>
          <p>${escape(p['description'] ?? '')}</p>
          ${
            sess?.accessToken
              ? `<form method="POST" action="/billing/checkout" style="display:inline">
                   <input type="hidden" name="planId" value="${escape(id)}"/>
                   <button>Subscribe</button>
                 </form>
                 ${trial > 0 ? `<form method="POST" action="/billing/trial/start" style="display:inline">
                   <input type="hidden" name="planId" value="${escape(id)}"/>
                   <button class="secondary">Start trial</button>
                 </form>` : ''}`
              : `<a class="btn secondary" href="/signup?planId=${escape(id)}">Sign up to subscribe</a>`
          }
        </div>`;
      })
      .join('');
    return res.send(
      layout('Plans', `<h1>Plans</h1><div class="grid">${cards || '<div class="card">No plans published yet.</div>'}</div>`, {
        session: sess,
        active: 'plans',
        ...flashFromQuery(req),
      }),
    );
  });

  // ── Signup ───────────────────────────────────────────────────────────
  r.get('/signup', (req, res) => {
    const planId = String(req.query['planId'] ?? '');
    res.send(
      layout(
        'Sign up',
        `<div class="card"><h1>Create your account</h1>
        <form method="POST" action="/signup">
          <label>Email</label><input name="email" type="email" required/>
          <label>Password (12+ chars, upper/lower/digit/symbol)</label><input name="password" type="password" required minlength="12"/>
          <label>First name</label><input name="firstName"/>
          <label>Last name</label><input name="lastName"/>
          ${planId ? `<input type="hidden" name="planId" value="${escape(planId)}"/>` : ''}
          <label><input name="marketingOptIn" type="checkbox"/> Send me product updates</label>
          <button>Sign up</button>
        </form>
        <p class="muted">After clicking, check the API logs / mailhog for the verification link.</p>
        </div>`,
        { active: 'signup', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/signup', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await publicCall(cfg.yocoreBaseUrl, '/v1/auth/signup', {
      method: 'POST',
      body: {
        email: body['email'],
        password: body['password'],
        productSlug: cfg.productSlug,
        name:
          body['firstName'] || body['lastName']
            ? { first: body['firstName'] || undefined, last: body['lastName'] || undefined }
            : undefined,
        marketingOptIn: body['marketingOptIn'] === 'on',
      },
    });
    if (!result.ok) {
      return res.redirect(`/signup?err=${encodeURIComponent(describeError(result))}`);
    }
    return res.redirect(
      `/signin?msg=${encodeURIComponent('Verification email sent. After verifying, sign in here.')}`,
    );
  });

  // ── Email verification ───────────────────────────────────────────────
  r.get('/verify-email', async (req, res) => {
    const token = String(req.query['token'] ?? '');
    if (!token) return res.redirect('/signin?err=' + encodeURIComponent('Missing token'));
    const result = await publicCall<{ alreadyVerified?: boolean; tokens?: SigninSuccess['tokens']; userId?: string; productId?: string | null }>(
      cfg.yocoreBaseUrl,
      `/v1/auth/verify-email`,
      { query: { token } },
    );
    if (!result.ok) {
      return res.redirect('/signin?err=' + encodeURIComponent(describeError(result)));
    }
    // If API auto-issued tokens, persist into session.
    if (result.body?.tokens) {
      setSession(req, {
        accessToken: result.body.tokens.accessToken,
        refreshToken: result.body.tokens.refreshToken,
        expiresAt: Date.now() + result.body.tokens.expiresIn * 1000,
        userId: result.body.userId ?? '',
        productId: result.body.productId ?? null,
      });
      return res.redirect('/account?msg=' + encodeURIComponent('Email verified — welcome!'));
    }
    return res.redirect('/signin?msg=' + encodeURIComponent('Email verified. Please sign in.'));
  });

  // ── Sign in ──────────────────────────────────────────────────────────
  r.get('/signin', (req, res) => {
    const sess = getSession(req);
    const mfa = sess?.mfaChallengeId
      ? `<div class="card"><h2>Enter MFA code</h2>
          <form method="POST" action="/signin/mfa">
            <label>TOTP / recovery code</label><input name="code" required autofocus/>
            <button>Verify</button>
          </form></div>`
      : '';
    res.send(
      layout(
        'Sign in',
        `${mfa}
        <div class="card"><h1>Sign in</h1>
        <form method="POST" action="/signin">
          <label>Email</label><input name="email" type="email" required/>
          <label>Password</label><input name="password" type="password" required/>
          <button>Sign in</button>
        </form>
        <p class="muted"><a href="/forgot-password">Forgot password?</a> · <a href="/signup">Need an account?</a></p>
        </div>`,
        { active: 'signin', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/signin', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await publicCall<SigninSuccess | SigninMfa>(cfg.yocoreBaseUrl, '/v1/auth/signin', {
      method: 'POST',
      body: { email: body['email'], password: body['password'], productSlug: cfg.productSlug },
    });
    if (!result.ok) {
      return res.redirect('/signin?err=' + encodeURIComponent(describeError(result)));
    }
    if (result.body.status === 'mfa_required') {
      setSession(req, {
        mfaChallengeId: result.body.mfaChallengeId,
        mfaEmail: body['email'],
      } as never);
      return res.redirect('/signin');
    }
    const ok = result.body;
    setSession(req, {
      accessToken: ok.tokens.accessToken,
      refreshToken: ok.tokens.refreshToken,
      expiresAt: Date.now() + ok.tokens.expiresIn * 1000,
      userId: ok.userId,
      productId: ok.productId,
      email: body['email'],
      mfaChallengeId: undefined,
      mfaEmail: undefined,
    });
    return res.redirect('/account?msg=' + encodeURIComponent('Welcome!'));
  });

  r.post('/signin/mfa', async (req, res) => {
    const body = req.body as Record<string, string>;
    const sess = getSession(req);
    if (!sess?.mfaChallengeId || !sess.mfaEmail) {
      return res.redirect('/signin?err=' + encodeURIComponent('Challenge expired'));
    }
    const result = await publicCall<SigninSuccess>(cfg.yocoreBaseUrl, '/v1/auth/signin', {
      method: 'POST',
      body: {
        email: sess.mfaEmail,
        password: '_',
        productSlug: cfg.productSlug,
        mfaChallengeId: sess.mfaChallengeId,
        mfaCode: body['code'],
      },
    });
    if (!result.ok || result.body.status !== 'signed_in') {
      return res.redirect('/signin?err=' + encodeURIComponent(describeError(result)));
    }
    const ok = result.body;
    setSession(req, {
      accessToken: ok.tokens.accessToken,
      refreshToken: ok.tokens.refreshToken,
      expiresAt: Date.now() + ok.tokens.expiresIn * 1000,
      userId: ok.userId,
      productId: ok.productId,
      email: sess.mfaEmail,
      mfaChallengeId: undefined,
      mfaEmail: undefined,
    });
    return res.redirect('/account?msg=' + encodeURIComponent('Signed in with MFA'));
  });

  // ── Forgot / reset password ──────────────────────────────────────────
  r.get('/forgot-password', (req, res) => {
    res.send(
      layout(
        'Forgot password',
        `<div class="card"><h1>Forgot password</h1>
        <form method="POST" action="/forgot-password">
          <label>Email</label><input name="email" type="email" required/>
          <button>Send reset link</button>
        </form></div>`,
        { ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/forgot-password', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await publicCall(cfg.yocoreBaseUrl, '/v1/auth/forgot-password', {
      method: 'POST',
      body: { email: body['email'], productSlug: cfg.productSlug },
    });
    if (!result.ok) return res.redirect('/forgot-password?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/signin?msg=' + encodeURIComponent('If the address exists, a reset email was sent.'));
  });

  r.get('/reset-password', (req, res) => {
    const token = String(req.query['token'] ?? '');
    res.send(
      layout(
        'Reset password',
        `<div class="card"><h1>Reset password</h1>
        <form method="POST" action="/reset-password">
          <input type="hidden" name="token" value="${escape(token)}"/>
          <label>New password (12+)</label><input name="password" type="password" required minlength="12"/>
          <button>Reset</button>
        </form></div>`,
        { ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/reset-password', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await publicCall(cfg.yocoreBaseUrl, '/v1/auth/reset-password', {
      method: 'POST',
      body: { token: body['token'], newPassword: body['password'] },
    });
    if (!result.ok) return res.redirect('/reset-password?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/signin?msg=' + encodeURIComponent('Password reset — sign in with the new password.'));
  });

  // ── Email change confirm (clicked from email) ───────────────────────
  r.get('/email-change-confirm', async (req, res) => {
    const token = String(req.query['token'] ?? '');
    const result = await publicCall(cfg.yocoreBaseUrl, '/v1/auth/email/change-confirm', {
      query: { token },
    });
    if (!result.ok) return res.redirect('/signin?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/signin?msg=' + encodeURIComponent('Email changed. Please sign in again.'));
  });

  // ── Sign out ─────────────────────────────────────────────────────────
  r.get('/signout', async (req, res) => {
    const sess = getSession(req);
    if (sess?.accessToken) {
      await publicCall(cfg.yocoreBaseUrl, '/v1/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${sess.accessToken}` },
        body: { refreshToken: sess.refreshToken, scope: 'session' },
      });
    }
    clearSession(req);
    return res.redirect('/?msg=' + encodeURIComponent('Signed out'));
  });

  // ── Debug: show current session blob ─────────────────────────────────
  r.get('/_debug/session', (req, res) => {
    const sess = getSession(req);
    res.send(layout('Session', `<h1>Session</h1>${jsonBlock(sess ?? null)}`, { session: sess }));
  });

  return r;
}
