/**
 * Workspace routes (Phase 3.2):
 *   GET  /workspaces                                        list + create form
 *   POST /workspaces                                        create
 *   GET  /workspaces/:id                                    members + invitations
 *   POST /workspaces/:id/update                             rename
 *   POST /workspaces/:id/delete                             soft-delete
 *   POST /workspaces/:id/restore                            restore
 *   POST /workspaces/:id/transfer                           transfer ownership
 *   POST /workspaces/:id/switch                             /v1/auth/switch-workspace
 *   POST /workspaces/:id/members/:userId/role               change role
 *   POST /workspaces/:id/members/:userId/remove             remove
 *   POST /workspaces/:id/invitations                        invite
 *   POST /workspaces/:id/invitations/:invId/revoke          revoke
 *   GET  /accept-invite                                     preview + form
 *   POST /accept-invite                                     POST /v1/invitations/accept (signed-in) or /accept-new
 */
import { Router } from 'express';
import { layout, jsonBlock, escape, flashFromQuery } from '../lib/views.js';
import { authCall, publicCall, describeError } from '../lib/api.js';
import { getSession, setSession, requireSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';

export function workspaceRouter(cfg: DemoConfig): Router {
  const r = Router();

  // ── Public: invitation preview / accept (works signed-in or not) ─────
  r.get('/accept-invite', async (req, res) => {
    const token = String(req.query['token'] ?? '');
    if (!token) return res.send(layout('Accept invite', '<div class="card">Missing token</div>'));
    const preview = await publicCall<{ isExistingUser?: boolean; email?: string; workspaceName?: string }>(
      cfg.yocoreBaseUrl,
      '/v1/invitations/preview',
      { query: { token } },
    );
    if (!preview.ok) return res.send(layout('Accept invite', `<div class="card">Failed: ${describeError(preview)}</div>`));
    const isExisting = Boolean(preview.body?.isExistingUser);
    const sess = getSession(req);
    return res.send(
      layout(
        'Accept invite',
        `<div class="card"><h1>You're invited</h1>${jsonBlock(preview.body)}
        ${
          isExisting
            ? sess?.accessToken
              ? `<form method="POST" action="/accept-invite"><input type="hidden" name="token" value="${escape(token)}"/><input type="hidden" name="mode" value="existing"/><button>Accept</button></form>`
              : `<p>Sign in first, then come back to this link.</p><a class="btn" href="/signin">Sign in</a>`
            : `<form method="POST" action="/accept-invite">
                <input type="hidden" name="token" value="${escape(token)}"/>
                <input type="hidden" name="mode" value="new"/>
                <label>Password (12+)</label><input name="password" type="password" required minlength="12"/>
                <label>First name</label><input name="firstName"/>
                <label>Last name</label><input name="lastName"/>
                <button>Create account & accept</button>
              </form>`
        }
        </div>`,
        { session: sess },
      ),
    );
  });

  r.post('/accept-invite', async (req, res) => {
    const body = req.body as Record<string, string>;
    if (body['mode'] === 'new') {
      const result = await publicCall(cfg.yocoreBaseUrl, '/v1/invitations/accept-new', {
        method: 'POST',
        body: {
          token: body['token'],
          password: body['password'],
          name:
            body['firstName'] || body['lastName']
              ? { first: body['firstName'] || undefined, last: body['lastName'] || undefined }
              : undefined,
        },
      });
      if (!result.ok) return res.redirect('/accept-invite?token=' + encodeURIComponent(body['token']!) + '&err=' + encodeURIComponent(describeError(result)));
      return res.redirect('/signin?msg=' + encodeURIComponent('Invitation accepted — please sign in.'));
    }
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/invitations/accept', {
      method: 'POST',
      body: { token: body['token'] },
    });
    if (!result.ok) return res.redirect('/?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/workspaces?msg=' + encodeURIComponent('Joined workspace.'));
  });

  // ── Authenticated workspace operations ───────────────────────────────
  r.use('/workspaces', requireSession);

  r.get('/workspaces', async (req, res) => {
    const list = await authCall<{ workspaces?: Array<Record<string, unknown>> }>(
      cfg.yocoreBaseUrl,
      req,
      '/v1/workspaces',
    );
    const sess = getSession(req);
    const items = (list.body?.workspaces ?? []) as Array<Record<string, unknown>>;
    const rows = items
      .map(
        (w) =>
          `<tr><td><a href="/workspaces/${escape(w['id'])}">${escape(w['name'])}</a></td>
           <td><code>${escape(w['id'])}</code></td>
           <td>${escape(w['status'])}</td>
           <td>
             <form method="POST" action="/workspaces/${escape(w['id'])}/switch" style="display:inline"><button class="secondary">Switch</button></form>
           </td></tr>`,
      )
      .join('');
    res.send(
      layout(
        'Workspaces',
        `<h1>Workspaces</h1>
        <div class="card"><table><tr><th>Name</th><th>Id</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="4">None — create one below.</td></tr>'}</table></div>
        <div class="card"><h3>Create workspace</h3>
          <form method="POST" action="/workspaces">
            <label>Name</label><input name="name" required/>
            <label>Slug (optional)</label><input name="slug"/>
            <button>Create</button>
          </form>
        </div>`,
        { session: sess, active: 'workspaces', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/workspaces', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/workspaces', {
      method: 'POST',
      body: { name: body['name'], slug: body['slug'] || undefined },
    });
    if (!result.ok) return res.redirect('/workspaces?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/workspaces?msg=Created');
  });

  r.get('/workspaces/:id', async (req, res) => {
    const id = req.params['id']!;
    const [ws, members, invites] = await Promise.all([
      authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}`),
      authCall<{ members?: Array<Record<string, unknown>> }>(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/members`),
      authCall<{ invitations?: Array<Record<string, unknown>> }>(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/invitations`),
    ]);
    const memberRows = (members.body?.members ?? [])
      .map(
        (m) =>
          `<tr><td>${escape(m['email'])}</td><td>${escape(m['roleSlug'])}</td><td>${escape(m['status'])}</td>
          <td>
            <form method="POST" action="/workspaces/${id}/members/${escape(m['userId'])}/role" style="display:inline">
              <select name="roleSlug">
                ${['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'].map((slug) => `<option ${slug === m['roleSlug'] ? 'selected' : ''}>${slug}</option>`).join('')}
              </select>
              <button class="secondary">Set</button>
            </form>
            <form method="POST" action="/workspaces/${id}/members/${escape(m['userId'])}/remove" style="display:inline">
              <button class="danger">Remove</button>
            </form>
          </td></tr>`,
      )
      .join('');
    const inviteRows = (invites.body?.invitations ?? [])
      .map(
        (i) =>
          `<tr><td>${escape(i['email'])}</td><td>${escape(i['roleSlug'])}</td><td>${escape(i['status'])}</td>
          <td><form method="POST" action="/workspaces/${id}/invitations/${escape(i['id'])}/revoke"><button class="danger">Revoke</button></form></td></tr>`,
      )
      .join('');
    return res.send(
      layout(
        ws.body && (ws.body as Record<string, unknown>)['name']
          ? String((ws.body as Record<string, unknown>)['name'])
          : 'Workspace',
        `<h1>Workspace</h1>
        <div class="card">${jsonBlock(ws.body)}</div>
        <div class="card"><h3>Rename</h3>
          <form method="POST" action="/workspaces/${id}/update">
            <label>New name</label><input name="name" required/>
            <button>Save</button>
          </form>
        </div>
        <div class="card"><h3>Members</h3><table><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${memberRows || '<tr><td colspan="4">None</td></tr>'}</table></div>
        <div class="card"><h3>Invite member</h3>
          <form method="POST" action="/workspaces/${id}/invitations">
            <label>Email</label><input name="email" type="email" required/>
            <label>Role</label>
            <select name="roleSlug">${['ADMIN', 'MEMBER', 'VIEWER'].map((s) => `<option>${s}</option>`).join('')}</select>
            <button>Invite</button>
          </form>
        </div>
        <div class="card"><h3>Pending invitations</h3><table><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${inviteRows || '<tr><td colspan="4">None</td></tr>'}</table></div>
        <div class="card"><h3>Transfer ownership</h3>
          <form method="POST" action="/workspaces/${id}/transfer">
            <label>New owner userId</label><input name="newOwnerUserId" required/>
            <label>Your password</label><input name="password" type="password" required/>
            <button class="danger">Transfer</button>
          </form>
        </div>
        <div class="card"><h3>Delete workspace</h3>
          <form method="POST" action="/workspaces/${id}/delete">
            <label>Confirm name</label><input name="confirmName" required/>
            <label>Password</label><input name="password" type="password" required/>
            <button class="danger">Delete (30-day grace)</button>
          </form>
          <form method="POST" action="/workspaces/${id}/restore" style="margin-top:6px"><button class="secondary">Restore</button></form>
        </div>`,
        { session: getSession(req), active: 'workspaces', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/workspaces/:id/update', async (req, res) => {
    const body = req.body as Record<string, string>;
    const id = req.params['id']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}`, {
      method: 'PATCH',
      body: { name: body['name'] },
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=Updated`);
  });

  r.post('/workspaces/:id/delete', async (req, res) => {
    const body = req.body as Record<string, string>;
    const id = req.params['id']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}`, {
      method: 'DELETE',
      body: { confirmName: body['confirmName'], password: body['password'] },
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect('/workspaces?msg=Deleted');
  });

  r.post('/workspaces/:id/restore', async (req, res) => {
    const id = req.params['id']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/restore`, { method: 'POST' });
    if (!result.ok) return res.redirect(`/workspaces?err=` + encodeURIComponent(describeError(result)));
    return res.redirect('/workspaces?msg=Restored');
  });

  r.post('/workspaces/:id/transfer', async (req, res) => {
    const body = req.body as Record<string, string>;
    const id = req.params['id']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/transfer-ownership`, {
      method: 'POST',
      body: { newOwnerUserId: body['newOwnerUserId'], password: body['password'] },
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=Transferred`);
  });

  r.post('/workspaces/:id/switch', async (req, res) => {
    const id = req.params['id']!;
    const result = await authCall<{ accessToken?: string; expiresIn?: number; workspaceId?: string }>(
      cfg.yocoreBaseUrl,
      req,
      '/v1/auth/switch-workspace',
      { method: 'POST', body: { workspaceId: id } },
    );
    if (!result.ok) return res.redirect('/workspaces?err=' + encodeURIComponent(describeError(result)));
    if (result.body?.accessToken && result.body.expiresIn) {
      setSession(req, {
        accessToken: result.body.accessToken,
        expiresAt: Date.now() + result.body.expiresIn * 1000,
        workspaceId: result.body.workspaceId ?? id,
      });
    }
    return res.redirect('/workspaces?msg=Switched');
  });

  r.post('/workspaces/:id/members/:userId/role', async (req, res) => {
    const body = req.body as Record<string, string>;
    const { id, userId } = req.params as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/members/${userId}`, {
      method: 'PATCH',
      body: { roleSlug: body['roleSlug'] },
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=RoleChanged`);
  });

  r.post('/workspaces/:id/members/:userId/remove', async (req, res) => {
    const { id, userId } = req.params as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/members/${userId}`, {
      method: 'DELETE',
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=Removed`);
  });

  r.post('/workspaces/:id/invitations', async (req, res) => {
    const body = req.body as Record<string, string>;
    const id = req.params['id']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/invitations`, {
      method: 'POST',
      body: { email: body['email'], roleSlug: body['roleSlug'] },
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=Invited`);
  });

  r.post('/workspaces/:id/invitations/:invId/revoke', async (req, res) => {
    const { id, invId } = req.params as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/workspaces/${id}/invitations/${invId}`, {
      method: 'DELETE',
    });
    if (!result.ok) return res.redirect(`/workspaces/${id}?err=` + encodeURIComponent(describeError(result)));
    return res.redirect(`/workspaces/${id}?msg=Revoked`);
  });

  return r;
}
