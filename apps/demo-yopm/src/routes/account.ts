/**
 * Account routes — all require an authenticated session:
 *   GET  /account                      → /v1/users/me-ish summary + nav
 *   GET  /account/sessions             → /v1/sessions
 *   POST /account/sessions/:id/revoke  → DELETE /v1/sessions/:id
 *   GET  /account/mfa                  → status + enrol/disable forms
 *   POST /account/mfa/enrol            → /v1/auth/mfa/enrol
 *   POST /account/mfa/verify           → /v1/auth/mfa/enrol/verify
 *   POST /account/mfa/regenerate       → /v1/auth/mfa/recovery-codes
 *   GET  /account/email-prefs          → /v1/users/me/email-preferences
 *   POST /account/email-prefs          → PATCH /v1/users/me/email-preferences
 *   POST /account/email-change         → /v1/auth/email/change-request
 *   POST /account/finalize-onboarding  → /v1/auth/finalize-onboarding (creates first workspace)
 *   GET  /account/data-exports         → list + request form
 *   POST /account/data-exports         → /v1/users/me/data-export
 *   GET  /account/deletion             → list pending + request form
 *   POST /account/deletion             → DELETE /v1/users/me
 *   POST /account/deletion/cancel      → /v1/users/me/cancel-deletion
 */
import { Router } from 'express';
import { layout, jsonBlock, escape, flashFromQuery } from '../lib/views.js';
import { authCall, describeError } from '../lib/api.js';
import { getSession, requireSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';

export function accountRouter(cfg: DemoConfig): Router {
  const r = Router();
  r.use(requireSession);

  r.get('/account', async (req, res) => {
    const [profileResult, mfaResult, workspacesResult] = await Promise.all([
      authCall<Record<string, unknown>>(cfg.yocoreBaseUrl, req, '/v1/users/me/profile'),
      authCall<Record<string, unknown>>(cfg.yocoreBaseUrl, req, '/v1/users/me/mfa/status'),
      authCall<{ workspaces?: Array<Record<string, unknown>> }>(cfg.yocoreBaseUrl, req, '/v1/workspaces'),
    ]);
    const sess = getSession(req);
    const p = profileResult.ok ? (profileResult.body as Record<string, unknown>) : null;
    const name = p ? (((p['name'] as Record<string, unknown> | null)?.['display'] ?? `${(p['name'] as Record<string, unknown> | null)?.['first'] ?? ''} ${(p['name'] as Record<string, unknown> | null)?.['last'] ?? ''}`.trim()) || '—') : (sess?.email ?? '—');
    const workspaces = workspacesResult.ok ? (workspacesResult.body?.workspaces ?? []) : [];

    const wsRows = (workspaces as Array<Record<string, unknown>>)
      .map((w) => `<tr>
        <td><code>${escape(w['id'])}</code></td>
        <td><b>${escape(w['name'])}</b></td>
        <td><span class="badge">${escape(w['status'] ?? 'ACTIVE')}</span></td>
        <td>
          <form method="POST" action="/workspaces/switch" style="display:inline">
            <input type="hidden" name="workspaceId" value="${escape(w['id'])}"/>
            <button class="secondary" style="padding:2px 8px">Switch</button>
          </form>
          <a class="btn secondary" href="/workspaces/${escape(w['id'])}" style="padding:2px 8px">Manage</a>
        </td>
      </tr>`)
      .join('');

    const mfaEnrolled = (mfaResult.body as Record<string, unknown>)?.['enrolled'] === true;

    res.send(
      layout(
        'Account',
        `<h1>Account</h1>

        <!-- Profile card -->
        <div class="card" style="display:flex;gap:24px;align-items:flex-start">
          <div style="width:64px;height:64px;border-radius:50%;background:#6366f1;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">
            ${escape(String(name)[0]?.toUpperCase() ?? '?')}
          </div>
          <div style="flex:1">
            <h2 style="margin:0 0 4px">${escape(String(name))}</h2>
            <p style="margin:0 0 4px">${escape(String(p?.['email'] ?? sess?.email ?? ''))}</p>
            <span class="badge">${escape(String(p?.['status'] ?? 'ACTIVE'))}</span>
            ${p?.['onboarded'] ? '' : '<span class="badge" style="background:#f59e0b;margin-left:4px">Not onboarded</span>'}
            <p class="muted" style="margin:8px 0 0">User ID: <code>${escape(sess?.userId)}</code> · Joined: ${escape(String(p?.['joinedAt'] ?? '—').slice(0, 10))}</p>
            ${p?.['lastLoginAt'] ? `<p class="muted" style="margin:4px 0 0">Last login: ${escape(String(p['lastLoginAt']).slice(0, 19).replace('T', ' '))} UTC</p>` : ''}
          </div>
        </div>

        <!-- Workspaces -->
        <div class="card">
          <h3>Your workspaces</h3>
          ${wsRows
            ? `<table><tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr>${wsRows}</table>`
            : '<p class="muted">No workspaces yet.</p>'}
          ${!p?.['onboarded']
            ? `<hr/><p class="muted">Create your first workspace:</p>
               <form method="POST" action="/account/finalize-onboarding" style="display:flex;gap:8px">
                 <input name="workspaceName" placeholder="Workspace name" required style="flex:1"/>
                 <button>Create</button>
               </form>`
            : ''}
        </div>

        <!-- Security + settings grid -->
        <div class="grid">
          <div class="card">
            <h3>MFA — ${mfaEnrolled ? '✅ enrolled' : '⚠️ not enrolled'}</h3>
            <p class="muted">Recovery codes remaining: ${escape(String((mfaResult.body as Record<string, unknown>)?.['recoveryCodesRemaining'] ?? '—'))}</p>
            <a class="btn" href="/account/mfa">Manage MFA</a>
          </div>
          <div class="card">
            <h3>Email preferences</h3>
            <p class="muted">Marketing, product updates, billing &amp; security emails.</p>
            <a class="btn secondary" href="/account/email-prefs">Manage</a>
          </div>
          <div class="card">
            <h3>Sessions</h3>
            <p class="muted">View and revoke all active sessions.</p>
            <a class="btn secondary" href="/account/sessions">View sessions</a>
          </div>
          <div class="card">
            <h3>Change email</h3>
            <form method="POST" action="/account/email-change">
              <label>New email</label><input name="newEmail" type="email" required/>
              <label>Current password</label><input name="password" type="password" required/>
              <button>Request change</button>
            </form>
          </div>
          <div class="card">
            <h3>Data export (GDPR)</h3>
            <p class="muted">Download a copy of your data.</p>
            <a class="btn secondary" href="/account/data-exports">Manage</a>
          </div>
          <div class="card">
            <h3>Account deletion (GDPR)</h3>
            <p class="muted">Request permanent deletion (30-day grace period).</p>
            <a class="btn danger" href="/account/deletion">Manage</a>
          </div>
        </div>`,
        { session: sess, active: 'account', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/finalize-onboarding', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/finalize-onboarding', {
      method: 'POST',
      body: { workspaceName: body['workspaceName'] },
    });
    if (!result.ok) return res.redirect('/account?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/workspaces?msg=' + encodeURIComponent('Workspace created'));
  });

  // ── Sessions ─────────────────────────────────────────────────────────
  r.get('/account/sessions', async (req, res) => {
    const result = await authCall<{ sessions?: Array<Record<string, unknown>> }>(
      cfg.yocoreBaseUrl,
      req,
      '/v1/sessions',
    );
    const items = (result.body?.sessions ?? []) as Array<Record<string, unknown>>;
    const rows = items
      .map(
        (s) =>
          `<tr><td><code>${escape(s['id'])}</code></td><td>${escape(s['userAgent'] ?? '')}</td><td>${escape(s['createdAt'] ?? '')}</td>
           <td><form method="POST" action="/account/sessions/${escape(s['id'])}/revoke"><button class="danger">Revoke</button></form></td></tr>`,
      )
      .join('');
    res.send(
      layout(
        'Sessions',
        `<h1>Active sessions</h1><div class="card"><table><tr><th>Id</th><th>UA</th><th>Created</th><th></th></tr>${rows || '<tr><td colspan="4">None</td></tr>'}</table></div>`,
        { session: getSession(req), active: 'sessions', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/sessions/:id/revoke', async (req, res) => {
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/sessions/${encodeURIComponent(req.params['id']!)}`, {
      method: 'DELETE',
    });
    if (!result.ok) return res.redirect('/account/sessions?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account/sessions?msg=Revoked');
  });

  // ── MFA ──────────────────────────────────────────────────────────────
  r.get('/account/mfa', async (req, res) => {
    const status = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/mfa/status');
    res.send(
      layout(
        'MFA',
        `<h1>Multi-factor auth</h1>
        <div class="card"><h3>Status</h3>${jsonBlock(status.body)}</div>
        <div class="card"><h3>Enrol (TOTP)</h3>
          <form method="POST" action="/account/mfa/enrol"><button>Start enrol</button></form>
          <p class="muted">Returns an otpauth:// URI + secret. Add to your authenticator, then verify below.</p>
          <form method="POST" action="/account/mfa/verify">
            <label>Enrolment id</label><input name="enrolmentId" required/>
            <label>6-digit code</label><input name="code" required pattern="\\d{6,8}"/>
            <button>Verify</button>
          </form>
        </div>
        <div class="card"><h3>Regenerate recovery codes</h3>
          <form method="POST" action="/account/mfa/regenerate"><button class="secondary">Regenerate</button></form>
        </div>`,
        { session: getSession(req), active: 'account', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/mfa/enrol', async (req, res) => {
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/mfa/enrol', { method: 'POST' });
    if (!result.ok) return res.redirect('/account/mfa?err=' + encodeURIComponent(describeError(result)));
    return res.send(
      layout(
        'MFA enrol',
        `<h1>Enrol MFA</h1><div class="card">${jsonBlock(result.body)}<p>Add the secret to your authenticator and submit the 6-digit code below.</p>
        <form method="POST" action="/account/mfa/verify">
          <label>Enrolment id</label><input name="enrolmentId" value="${escape((result.body as Record<string, unknown>)['enrolmentId'])}" required/>
          <label>Code</label><input name="code" required/>
          <button>Verify</button>
        </form></div>`,
        { session: getSession(req), active: 'account' },
      ),
    );
  });

  r.post('/account/mfa/verify', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/mfa/enrol/verify', {
      method: 'POST',
      body: { enrolmentId: body['enrolmentId'], code: body['code'] },
    });
    if (!result.ok) return res.redirect('/account/mfa?err=' + encodeURIComponent(describeError(result)));
    return res.send(
      layout(
        'Recovery codes',
        `<h1>MFA enrolled — save your recovery codes</h1><div class="card">${jsonBlock(result.body)}</div><a class="btn" href="/account/mfa">Done</a>`,
        { session: getSession(req), active: 'account' },
      ),
    );
  });

  r.post('/account/mfa/regenerate', async (req, res) => {
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/mfa/recovery-codes', { method: 'POST' });
    if (!result.ok) return res.redirect('/account/mfa?err=' + encodeURIComponent(describeError(result)));
    return res.send(
      layout('New recovery codes', `<h1>New recovery codes</h1><div class="card">${jsonBlock(result.body)}</div><a class="btn" href="/account/mfa">Done</a>`, {
        session: getSession(req),
      }),
    );
  });

  // ── Email preferences ────────────────────────────────────────────────
  r.get('/account/email-prefs', async (req, res) => {
    const cur = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me/email-preferences');
    res.send(
      layout(
        'Email prefs',
        `<h1>Email preferences</h1>
        <div class="card">${jsonBlock(cur.body)}
        <form method="POST" action="/account/email-prefs">
          <label><input type="checkbox" name="transactional" checked/> Transactional</label>
          <label><input type="checkbox" name="productUpdates"/> Product updates</label>
          <label><input type="checkbox" name="marketing"/> Marketing</label>
          <button>Save</button>
        </form></div>`,
        { session: getSession(req), active: 'account', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/email-prefs', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me/email-preferences', {
      method: 'PATCH',
      body: {
        transactional: body['transactional'] === 'on',
        productUpdates: body['productUpdates'] === 'on',
        marketing: body['marketing'] === 'on',
      },
    });
    if (!result.ok) return res.redirect('/account/email-prefs?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account/email-prefs?msg=Saved');
  });

  // ── Email change ─────────────────────────────────────────────────────
  r.post('/account/email-change', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/auth/email/change-request', {
      method: 'POST',
      body: { newEmail: body['newEmail'], password: body['password'] },
    });
    if (!result.ok) return res.redirect('/account?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account?msg=' + encodeURIComponent('Confirmation sent to new address.'));
  });

  // ── Data export ──────────────────────────────────────────────────────
  r.get('/account/data-exports', async (req, res) => {
    const list = await authCall<{ exports?: Array<Record<string, unknown>> }>(
      cfg.yocoreBaseUrl,
      req,
      '/v1/users/me/data-exports',
    );
    res.send(
      layout(
        'Data exports',
        `<h1>Data exports (GDPR)</h1>
        <div class="card">${jsonBlock(list.body)}
        <form method="POST" action="/account/data-exports">
          <label>Scope</label>
          <select name="scope"><option value="account">Account-wide</option><option value="product">This product</option></select>
          <button>Request export</button>
        </form></div>`,
        { session: getSession(req), active: 'account', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/data-exports', async (req, res) => {
    const body = req.body as Record<string, string>;
    const productScoped = body['scope'] === 'product';
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me/data-export', {
      method: 'POST',
      body: {
        scope: body['scope'],
        ...(productScoped ? { productId: getSession(req)?.productId } : {}),
      },
    });
    if (!result.ok) return res.redirect('/account/data-exports?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account/data-exports?msg=Requested');
  });

  // ── Deletion ─────────────────────────────────────────────────────────
  r.get('/account/deletion', async (req, res) => {
    const list = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me/deletion-requests');
    res.send(
      layout(
        'Deletion',
        `<h1>Account / product deletion (GDPR)</h1>
        <div class="card">${jsonBlock(list.body)}
        <h3>Request deletion</h3>
        <form method="POST" action="/account/deletion">
          <label>Scope</label>
          <select name="scope"><option value="account">Account (all products)</option><option value="product">Product only</option></select>
          <label>Password (re-auth)</label><input name="password" type="password" required/>
          <button class="danger">Request deletion</button>
        </form>
        <h3>Cancel pending deletion</h3>
        <form method="POST" action="/account/deletion/cancel">
          <label>Scope</label>
          <select name="scope"><option value="account">account</option><option value="product">product</option></select>
          <button class="secondary">Cancel</button>
        </form>
        </div>`,
        { session: getSession(req), active: 'account', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/account/deletion', async (req, res) => {
    const body = req.body as Record<string, string>;
    const productScoped = body['scope'] === 'product';
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me', {
      method: 'DELETE',
      body: {
        scope: body['scope'],
        password: body['password'],
        ...(productScoped ? { productId: getSession(req)?.productId } : {}),
      },
    });
    if (!result.ok) return res.redirect('/account/deletion?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account/deletion?msg=Requested');
  });

  r.post('/account/deletion/cancel', async (req, res) => {
    const body = req.body as Record<string, string>;
    const productScoped = body['scope'] === 'product';
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/users/me/cancel-deletion', {
      method: 'POST',
      query: {
        scope: body['scope'],
        ...(productScoped ? { productId: getSession(req)?.productId ?? undefined } : {}),
      },
    });
    if (!result.ok) return res.redirect('/account/deletion?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/account/deletion?msg=Cancelled');
  });

  return r;
}
