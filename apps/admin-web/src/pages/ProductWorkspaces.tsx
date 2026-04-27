import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Empty, ErrorAlert, Input, StatusBadge } from '../components/ui.js';

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerUserId: string;
  billingContactUserId: string;
  suspended: boolean;
  suspensionReason: string | null;
  trialConverted: boolean;
  dataDeleted: boolean;
  voluntaryDeletionFinalizesAt: string | null;
  createdAt: string;
}

export function ProductWorkspacesPage() {
  const { productId = '' } = useParams<{ productId: string }>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'workspaces', productId, q, status, cursor],
    queryFn: () =>
      api<{ workspaces: WorkspaceRow[]; nextCursor: string | null }>(
        'GET',
        `/v1/admin/products/${productId}/workspaces`,
        {
          query: {
            q: q || undefined,
            status: status || undefined,
            cursor: cursor ?? undefined,
            limit: 50,
          },
        },
      ),
    enabled: !!productId,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Workspaces</h1>
        <Link to={`/products/${productId}`} className="text-sm text-brand-700 hover:underline">
          ← Back to product
        </Link>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Search by name</label>
          <Input
            value={q}
            placeholder="acme"
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(null);
            }}
          />
        </div>
        <div>
          <label className="label">Status</label>
          <select
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="DELETED">Deleted</option>
          </select>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {list.data && (list.data.workspaces.length === 0 ? <Empty>No workspaces.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Slug</th>
                <th className="th">Status</th>
                <th className="th">Trial converted</th>
                <th className="th">Created</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.workspaces.map((w) => (
                <tr key={w.id}>
                  <td className="td">{w.name}</td>
                  <td className="td font-mono text-xs">{w.slug}</td>
                  <td className="td">
                    <StatusBadge status={w.status} />
                    {w.suspended && <span className="badge-red ml-1">SUSPENDED</span>}
                    {w.dataDeleted && <span className="badge-red ml-1">DATA DELETED</span>}
                    {w.voluntaryDeletionFinalizesAt && (
                      <span className="badge-yellow ml-1">DELETING</span>
                    )}
                  </td>
                  <td className="td text-xs">{w.trialConverted ? '✓' : '—'}</td>
                  <td className="td text-xs">{new Date(w.createdAt).toLocaleDateString()}</td>
                  <td className="td">
                    <Link
                      to={`/products/${productId}/workspaces/${w.id}`}
                      className="text-brand-700 text-sm hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {list.data?.nextCursor && (
          <div className="p-3 text-right">
            <button
              className="btn-secondary"
              onClick={() => list.data && setCursor(list.data.nextCursor)}
            >
              Next page →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
