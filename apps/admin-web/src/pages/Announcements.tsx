import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input, Label } from '../components/ui.js';

interface Announcement {
  id: string;
  productId: string | null;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  audience: 'all_users' | 'product_admins' | 'super_admin_only';
  publishedAt: string | null;
  expiresAt: string | null;
  publishedBy: string | null;
  archivedAt: string | null;
  createdAt: string;
}

const EMPTY = {
  productId: '',
  title: '',
  body: '',
  severity: 'info' as 'info' | 'warning' | 'critical',
  audience: 'all_users' as 'all_users' | 'product_admins' | 'super_admin_only',
  expiresAt: '',
};

export function AnnouncementsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api<{ products: Array<{ id: string; name: string }> }>('GET', '/v1/admin/products'),
  });

  const list = useQuery({
    queryKey: ['admin', 'announcements', includeArchived],
    queryFn: () =>
      api<{ announcements: Announcement[] }>('GET', '/v1/admin/announcements', {
        query: { includeArchived: includeArchived ? 'true' : undefined, limit: 100 },
      }),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('POST', '/v1/admin/announcements', { body, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setShowForm(false);
      setForm(EMPTY);
      void qc.invalidateQueries({ queryKey: ['admin', 'announcements'] });
    },
    onError: (e) => setError((e as Error).message),
  });
  const publish = useMutation({
    mutationFn: (id: string) =>
      api('POST', `/v1/admin/announcements/${id}/publish`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'announcements'] }),
    onError: (e) => setError((e as Error).message),
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      api('POST', `/v1/admin/announcements/${id}/archive`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'announcements'] }),
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Announcements</h1>
        <div className="flex gap-2 items-center">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New announcement'}
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="card space-y-3">
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="a-product">Product (blank = global)</Label>
              <select
                id="a-product"
                className="input w-full"
                value={form.productId}
                onChange={(e) => setForm({ ...form, productId: e.target.value })}
              >
                <option value="">— Global —</option>
                {products.data?.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="a-sev">Severity</Label>
              <select
                id="a-sev"
                className="input w-full"
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as 'info' | 'warning' | 'critical' })}
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <Label htmlFor="a-aud">Audience</Label>
              <select
                id="a-aud"
                className="input w-full"
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value as 'all_users' | 'product_admins' | 'super_admin_only' })}
              >
                <option value="all_users">All users</option>
                <option value="product_admins">Product admins only</option>
                <option value="super_admin_only">Super-admin only</option>
              </select>
            </div>
            <div>
              <Label htmlFor="a-exp">Expires (ISO, blank = never)</Label>
              <Input
                id="a-exp"
                placeholder="2025-12-31T23:59:00.000Z"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="a-title">Title</Label>
              <Input id="a-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="a-body">Body</Label>
              <textarea
                id="a-body"
                className="input w-full min-h-[100px]"
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            </div>
          </div>
          <Button
            loading={create.isPending}
            onClick={() => {
              setError(null);
              create.mutate({
                productId: form.productId || null,
                title: form.title,
                body: form.body,
                severity: form.severity,
                audience: form.audience,
                expiresAt: form.expiresAt || null,
              });
            }}
          >
            Create (DRAFT)
          </Button>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {list.data && (list.data.announcements.length === 0 ? <Empty>No announcements.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Title</th>
                <th className="th">Severity</th>
                <th className="th">Audience</th>
                <th className="th">Scope</th>
                <th className="th">Status</th>
                <th className="th">Expires</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.announcements.map((a) => {
                const status = a.archivedAt ? 'ARCHIVED' : a.publishedAt ? 'PUBLISHED' : 'DRAFT';
                const sevColor =
                  a.severity === 'critical' ? 'badge-red' :
                  a.severity === 'warning' ? 'badge-yellow' : 'badge-slate';
                return (
                  <tr key={a.id}>
                    <td className="td">{a.title}</td>
                    <td className="td"><span className={sevColor}>{a.severity}</span></td>
                    <td className="td text-xs">{a.audience}</td>
                    <td className="td text-xs">{a.productId ?? 'global'}</td>
                    <td className="td text-xs">{status}</td>
                    <td className="td text-xs">{a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : '—'}</td>
                    <td className="td">
                      <div className="flex gap-2">
                        {!a.publishedAt && !a.archivedAt && (
                          <button onClick={() => publish.mutate(a.id)} className="text-xs text-brand-700 hover:underline">
                            Publish
                          </button>
                        )}
                        {!a.archivedAt && (
                          <button onClick={() => archive.mutate(a.id)} className="text-xs text-rose-600 hover:underline">
                            Archive
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
