/**
 * Projects (product-owned data) — stored in YoPM's OWN database.
 *
 * Demonstrates the YoCore architecture: identity / billing / workspaces
 * live in the YoCore API + DB, while product-specific entities (here,
 * Projects) live in the product's own database. We only borrow the
 * `userId` and `workspaceId` strings from the signed-in YoCore session.
 *
 *   GET  /projects                  list current workspace's projects
 *   POST /projects                  create
 *   POST /projects/:id/archive      archive
 *   POST /projects/:id/unarchive    unarchive
 *   POST /projects/:id/delete       hard-delete
 */
import { Router } from 'express';
import { layout, escape, flashFromQuery } from '../lib/views.js';
import { getSession, requireSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';
import { getYopmDb } from '../db/connection.js';
import { getProjectModel, newProjectId } from '../db/project.model.js';

export function projectsRouter(_cfg: DemoConfig): Router {
  const r = Router();
  r.use(requireSession);

  // ── List ────────────────────────────────────────────────────────────────
  r.get('/projects', async (req, res) => {
    const sess = getSession(req);
    const Project = getProjectModel(getYopmDb());
    if (!sess?.workspaceId) {
      return res.send(
        layout(
          'Projects',
          `<h1>Projects</h1>
          <div class="card">
            <p>You need to be inside a workspace to manage projects.</p>
            <a class="btn" href="/account">Pick / create a workspace</a>
          </div>`,
          { session: sess, active: 'projects', ...flashFromQuery(req) },
        ),
      );
    }

    const projects = await Project.find({ workspaceId: sess.workspaceId })
      .sort({ updatedAt: -1 })
      .lean();

    const rows = projects
      .map(
        (p) => `<tr>
          <td><b>${escape(p.name)}</b><br/><small class="muted">${escape(p._id)}</small></td>
          <td>${escape(p.description) || '<span class="muted">—</span>'}</td>
          <td><span class="badge ${p.status === 'ARCHIVED' ? 'secondary' : ''}">${escape(p.status)}</span></td>
          <td>${escape(new Date(p.updatedAt).toISOString().slice(0, 10))}</td>
          <td>
            ${p.status === 'ACTIVE'
              ? `<form method="POST" action="/projects/${escape(p._id)}/archive" style="display:inline">
                   <button class="secondary" style="padding:2px 8px">Archive</button>
                 </form>`
              : `<form method="POST" action="/projects/${escape(p._id)}/unarchive" style="display:inline">
                   <button class="secondary" style="padding:2px 8px">Unarchive</button>
                 </form>`}
            <form method="POST" action="/projects/${escape(p._id)}/delete" style="display:inline" onsubmit="return confirm('Delete project?')">
              <button class="danger" style="padding:2px 8px">Delete</button>
            </form>
          </td>
        </tr>`,
      )
      .join('');

    res.send(
      layout(
        'Projects',
        `<h1>Projects</h1>
        <p class="muted">
          Stored in <code>yopm_demo</code> (the product's own database) — separate from YoCore.
          Workspace: <code>${escape(sess.workspaceId)}</code>
        </p>

        <div class="card">
          <h3>Create project</h3>
          <form method="POST" action="/projects">
            <label>Name</label><input name="name" required maxlength="120" placeholder="Marketing site redesign"/>
            <label>Description</label><textarea name="description" maxlength="2000" rows="3" placeholder="Optional"></textarea>
            <button>Create</button>
          </form>
        </div>

        <div class="card">
          <h3>Your projects (${projects.length})</h3>
          ${rows
            ? `<table>
                <tr><th>Name</th><th>Description</th><th>Status</th><th>Updated</th><th>Actions</th></tr>
                ${rows}
              </table>`
            : '<p class="muted">No projects yet — create your first above.</p>'}
        </div>`,
        { session: sess, active: 'projects', ...flashFromQuery(req) },
      ),
    );
    return;
  });

  // ── Create ──────────────────────────────────────────────────────────────
  r.post('/projects', async (req, res) => {
    const sess = getSession(req);
    if (!sess?.workspaceId || !sess.userId) {
      return res.redirect('/projects?msg=No+workspace');
    }
    const body = req.body as Record<string, string>;
    const name = (body['name'] ?? '').trim();
    if (!name) return res.redirect('/projects?msg=Name+required');

    const Project = getProjectModel(getYopmDb());
    await Project.create({
      _id: newProjectId(),
      workspaceId: sess.workspaceId,
      ownerUserId: sess.userId,
      name,
      description: (body['description'] ?? '').trim(),
      status: 'ACTIVE',
    });
    return res.redirect('/projects?msg=Project+created');
  });

  // ── Archive / Unarchive / Delete ────────────────────────────────────────
  r.post('/projects/:id/archive', async (req, res) => {
    const sess = getSession(req);
    if (!sess?.workspaceId) return res.redirect('/projects');
    const Project = getProjectModel(getYopmDb());
    await Project.updateOne(
      { _id: req.params['id'], workspaceId: sess.workspaceId },
      { $set: { status: 'ARCHIVED' } },
    );
    return res.redirect('/projects?msg=Archived');
  });

  r.post('/projects/:id/unarchive', async (req, res) => {
    const sess = getSession(req);
    if (!sess?.workspaceId) return res.redirect('/projects');
    const Project = getProjectModel(getYopmDb());
    await Project.updateOne(
      { _id: req.params['id'], workspaceId: sess.workspaceId },
      { $set: { status: 'ACTIVE' } },
    );
    return res.redirect('/projects?msg=Unarchived');
  });

  r.post('/projects/:id/delete', async (req, res) => {
    const sess = getSession(req);
    if (!sess?.workspaceId) return res.redirect('/projects');
    const Project = getProjectModel(getYopmDb());
    await Project.deleteOne({ _id: req.params['id'], workspaceId: sess.workspaceId });
    return res.redirect('/projects?msg=Deleted');
  });

  return r;
}
