import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Empty, ErrorAlert, StatusBadge } from '../components/ui.js';

interface ProductUserRow {
  id: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
  status: string;
  productRole: string;
  name: { first: string | null; last: string | null; display: string | null } | null;
  lastLoginAt: string | null;
  joinedAt: string;
  mfaEnrolledAt: string | null;
  emailDeliverable: boolean;
}

export function ProductUsersPage() {
  const { productId = '' } = useParams<{ productId: string }>();
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'product-users', productId, status, cursor],
    queryFn: () =>
      api<{ users: ProductUserRow[]; nextCursor: string | null }>(
        'GET',
        `/v1/admin/products/${productId}/users`,
        { query: { status: status || undefined, cursor: cursor ?? undefined, limit: 50 } },
      ),
    enabled: !!productId,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Users in product</h1>
        <Link to={`/products/${productId}`} className="text-sm text-brand-700 hover:underline">
          ← Back to product
        </Link>
      </div>

      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Status filter</label>
          <select
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">All</option>
            <option value="UNVERIFIED">Unverified</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="BANNED">Banned</option>
            <option value="DELETED">Deleted</option>
          </select>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {list.data && (list.data.users.length === 0 ? <Empty>No users.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Email</th>
                <th className="th">Name</th>
                <th className="th">Status</th>
                <th className="th">Role</th>
                <th className="th">MFA</th>
                <th className="th">Joined</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.users.map((u) => (
                <tr key={u.id}>
                  <td className="td">
                    {u.email ?? '—'}{' '}
                    {u.email && !u.emailVerified && <span className="badge-yellow ml-1">UNVERIFIED</span>}
                    {!u.emailDeliverable && <span className="badge-red ml-1">UNDELIVERABLE</span>}
                  </td>
                  <td className="td">{u.name?.display ?? '—'}</td>
                  <td className="td"><StatusBadge status={u.status} /></td>
                  <td className="td text-xs">{u.productRole}</td>
                  <td className="td text-xs">{u.mfaEnrolledAt ? '✓' : '—'}</td>
                  <td className="td text-xs">{new Date(u.joinedAt).toLocaleDateString()}</td>
                  <td className="td">
                    <Link to={`/products/${productId}/users/${u.userId}`} className="text-brand-700 text-sm hover:underline">
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
