/**
 * V1.2-C — Product Admins screen (Screen 15).
 *
 * Lists all PRODUCT_ADMIN users in the product, lets SUPER_ADMIN promote any
 * existing product user to PRODUCT_ADMIN or revoke admin from a current one.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { ErrorAlert, Empty, StatusBadge } from '../components/ui.js';

interface AdminRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  status: string;
  joinedAt: string | null;
  lastLoginAt: string | null;
}

interface ProductUserRow {
  userId: string;
  email: string | null;
  status: string;
  productRole: string;
  name: { display: string | null } | null;
}

export function ProductAdminsPage() {
  const { productId = '' } = useParams<{ productId: string }>();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const adminsQ = useQuery({
    queryKey: ['admin', 'product-admins', productId],
    queryFn: () =>
      api<{ admins: AdminRow[] }>('GET', `/v1/admin/products/${productId}/admins`),
    enabled: !!productId,
  });

  // Fetch ACTIVE end-users for the picker.
  const usersQ = useQuery({
    queryKey: ['admin', 'product-users-active', productId],
    queryFn: () =>
      api<{ users: ProductUserRow[]; nextCursor: string | null }>(
        'GET',
        `/v1/admin/products/${productId}/users`,
        { query: { status: 'ACTIVE', limit: 100 } },
      ),
    enabled: !!productId,
  });

  const grantMut = useMutation({
    mutationFn: (userId: string) =>
      api('POST', `/v1/admin/products/${productId}/admins`, {
        body: { userId },
        idempotencyKey: `grant-${productId}-${userId}-${Date.now()}`,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'product-admins', productId] }),
    onError: (e: unknown) =>
      setError(e instanceof ApiError ? e.message : String(e)),
  });

  const revokeMut = useMutation({
    mutationFn: (userId: string) =>
      api('DELETE', `/v1/admin/products/${productId}/admins/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'product-admins', productId] }),
    onError: (e: unknown) =>
      setError(e instanceof ApiError ? e.message : String(e)),
  });

  const adminUserIds = new Set(adminsQ.data?.admins.map((a) => a.userId) ?? []);
  const candidates = (usersQ.data?.users ?? [])
    .filter((u) => !adminUserIds.has(u.userId) && u.productRole !== 'PRODUCT_ADMIN')
    .filter(
      (u) =>
        !search ||
        u.email?.toLowerCase().includes(search.toLowerCase()) ||
        u.name?.display?.toLowerCase().includes(search.toLowerCase()),
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Product Admins</h1>
        <Link to={`/products/${productId}`} className="text-sm text-brand-700 hover:underline">
          ← Back to product
        </Link>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      <section>
        <h2 className="mb-2 text-lg font-medium">Current admins</h2>
        <div className="card overflow-hidden p-0">
          {adminsQ.error && <div className="p-4"><ErrorAlert>{(adminsQ.error as Error).message}</ErrorAlert></div>}
          {adminsQ.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
          {adminsQ.data && (adminsQ.data.admins.length === 0 ? <Empty>No admins yet.</Empty> : (
            <table className="table">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Email</th>
                  <th className="th">Display name</th>
                  <th className="th">Status</th>
                  <th className="th">Joined</th>
                  <th className="th">Last login</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {adminsQ.data.admins.map((a) => (
                  <tr key={a.userId} className="border-t">
                    <td className="td">{a.email ?? '—'}</td>
                    <td className="td">{a.displayName ?? '—'}</td>
                    <td className="td"><StatusBadge status={a.status} /></td>
                    <td className="td">{a.joinedAt ? new Date(a.joinedAt).toLocaleDateString() : '—'}</td>
                    <td className="td">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : '—'}</td>
                    <td className="td text-right">
                      <button
                        className="btn btn-danger text-xs"
                        onClick={() => {
                          setError(null);
                          if (confirm(`Revoke PRODUCT_ADMIN from ${a.email ?? a.userId}?`)) {
                            revokeMut.mutate(a.userId);
                          }
                        }}
                        disabled={revokeMut.isPending}
                      >
                        Revoke admin
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Grant admin to an end user</h2>
        <div className="card space-y-3">
          <input
            className="input"
            placeholder="Search by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {usersQ.isLoading && <p className="text-sm text-slate-500">Loading users…</p>}
          {!usersQ.isLoading && candidates.length === 0 && (
            <p className="text-sm text-slate-500">No matching users.</p>
          )}
          <ul className="divide-y">
            {candidates.slice(0, 20).map((u) => (
              <li key={u.userId} className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">{u.email ?? u.userId}</div>
                  {u.name?.display && (
                    <div className="text-xs text-slate-500">{u.name.display}</div>
                  )}
                </div>
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => {
                    setError(null);
                    grantMut.mutate(u.userId);
                  }}
                  disabled={grantMut.isPending}
                >
                  Grant admin
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
