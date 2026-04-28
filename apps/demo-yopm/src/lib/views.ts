/**
 * 👉 Tiny server-rendered HTML helpers. Zero deps, zero build step.
 * Each route returns `layout(title, body)`. Forms POST to themselves,
 * results are flashed via `?msg=` / `?err=` query params.
 */
import type { DemoSession } from './session.js';

export function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const css = `
  :root { --bg:#0b0d10; --fg:#e7eaee; --mute:#8a93a0; --acc:#5b8def; --bad:#ef5b6e; --good:#5be8a3; --card:#161a20; --br:#252a33; }
  body { margin:0; font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  a { color:var(--acc); text-decoration:none; } a:hover { text-decoration:underline; }
  header { padding:14px 24px; border-bottom:1px solid var(--br); display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
  header .brand { font-weight:600; }
  header nav a { margin-right:14px; color:var(--mute); }
  header nav a.active { color:var(--fg); }
  main { max-width:920px; margin:0 auto; padding:24px; }
  h1, h2, h3 { margin-top:0; }
  .card { background:var(--card); border:1px solid var(--br); border-radius:8px; padding:18px; margin-bottom:16px; }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); }
  label { display:block; font-size:12px; color:var(--mute); margin-top:10px; }
  input, select, textarea { width:100%; padding:8px 10px; border-radius:6px; border:1px solid var(--br); background:#0f1217; color:var(--fg); font:inherit; box-sizing:border-box; }
  button, .btn { display:inline-block; padding:8px 14px; background:var(--acc); color:#fff; border:0; border-radius:6px; cursor:pointer; font:inherit; margin-top:14px; }
  button.secondary, .btn.secondary { background:transparent; border:1px solid var(--br); color:var(--fg); }
  button.danger, .btn.danger { background:var(--bad); }
  .flash.ok { color:var(--good); padding:10px; background:#0f3a26; border-radius:6px; margin-bottom:16px; }
  .flash.err { color:var(--bad); padding:10px; background:#3a1018; border-radius:6px; margin-bottom:16px; }
  pre { background:#0f1217; padding:12px; border-radius:6px; overflow:auto; font-size:12px; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:8px 10px; border-bottom:1px solid var(--br); text-align:left; font-size:13px; }
  th { color:var(--mute); font-weight:500; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .muted { color:var(--mute); font-size:12px; }
`;

export interface LayoutOpts {
  session?: DemoSession | undefined;
  flashOk?: string | undefined;
  flashErr?: string | undefined;
  active?: string | undefined;
}

export function layout(title: string, body: string, opts: LayoutOpts = {}): string {
  const signedIn = Boolean(opts.session?.accessToken);
  const navItem = (href: string, label: string, key: string): string =>
    `<a href="${href}" class="${opts.active === key ? 'active' : ''}">${label}</a>`;
  const nav = signedIn
    ? [
        navItem('/account', 'Account', 'account'),
        navItem('/workspaces', 'Workspaces', 'workspaces'),
        navItem('/projects', 'Projects', 'projects'),
        navItem('/billing', 'Billing', 'billing'),
        navItem('/bundles', 'Bundles', 'bundles'),
        navItem('/account/sessions', 'Sessions', 'sessions'),
        navItem('/signout', 'Sign out', 'signout'),
      ].join('')
    : [
        navItem('/plans', 'Plans', 'plans'),
        navItem('/signup', 'Sign up', 'signup'),
        navItem('/signin', 'Sign in', 'signin'),
      ].join('');
  const flash = opts.flashOk
    ? `<div class="flash ok">${escape(opts.flashOk)}</div>`
    : opts.flashErr
      ? `<div class="flash err">${escape(opts.flashErr)}</div>`
      : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)} — YoPM Demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body>
<header>
  <div class="brand"><a href="/" style="color:inherit">YoPM Demo</a></div>
  <nav>${nav}</nav>
  ${signedIn ? `<div class="muted" style="margin-left:auto">${escape(opts.session?.email ?? opts.session?.userId)}</div>` : ''}
</header>
<main>${flash}${body}</main></body></html>`;
}

/** Read flash messages from query string. */
export function flashFromQuery(req: { query: Record<string, unknown> }): {
  flashOk?: string;
  flashErr?: string;
} {
  const ok = typeof req.query['msg'] === 'string' ? (req.query['msg'] as string) : undefined;
  const err = typeof req.query['err'] === 'string' ? (req.query['err'] as string) : undefined;
  const out: { flashOk?: string; flashErr?: string } = {};
  if (ok) out.flashOk = ok;
  if (err) out.flashErr = err;
  return out;
}

export function jsonBlock(value: unknown): string {
  return `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;
}
