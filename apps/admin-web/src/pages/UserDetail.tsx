import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorAlert, StatusBadge } from '../components/ui.js';

interface UserDetailResponse {
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    createdAt: string;
  };
  productUser: {
    id: string;
    status: string;
    productRole: string;
    name: { first: string | null; last: string | null; display: string | null } | null;
    locale: string;
    timezone: string;
    lastLoginAt: string | null;
    lastLoginIp: string | null;
    lastActiveAt: string | null;
    joinedAt: string;
    onboarded: boolean;
    mfaEnrolledAt: string | null;
    emailPreferences: Record<string, boolean>;
    emailDeliverable: boolean;
    failedLoginAttempts: number;
    lockedUntil: string | null;
  };
  subscriptions: Array<{
    id: string;
    status: string;
    planId: string;
    subjectType: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    isBundleParent: boolean;
  }>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm mt-0.5">{value ?? '—'}</div>
    </div>
  );
}

export function UserDetailPage() {
  const { productId = '', userId = '' } = useParams<{ productId: string; userId: string }>();
  const detail = useQuery({
    queryKey: ['admin', 'user-detail', productId, userId],
    queryFn: () =>
      api<UserDetailResponse>('GET', `/v1/admin/products/${productId}/users/${userId}`),
    enabled: !!productId && !!userId,
  });

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (detail.error) return <ErrorAlert>{(detail.error as Error).message}</ErrorAlert>;
  if (!detail.data) return null;
  const { user, productUser, subscriptions } = detail.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/products/${productId}/users`} className="text-sm text-brand-700 hover:underline">
          ← All users
        </Link>
        <h1 className="text-2xl font-semibold mt-2">{productUser.name?.display ?? user.email}</h1>
        <p className="text-sm text-slate-500">{user.email}</p>
      </div>

      <div className="card grid grid-cols-2 md:grid-cols-3 gap-4">
        <Field label="Status" value={<StatusBadge status={productUser.status} />} />
        <Field label="Role" value={productUser.productRole} />
        <Field label="MFA" value={productUser.mfaEnrolledAt ? `Enrolled ${new Date(productUser.mfaEnrolledAt).toLocaleDateString()}` : 'Not enrolled'} />
        <Field label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
        <Field label="Email deliverable" value={productUser.emailDeliverable ? 'Yes' : 'No'} />
        <Field label="Onboarded" value={productUser.onboarded ? 'Yes' : 'No'} />
        <Field label="Locale / TZ" value={`${productUser.locale} · ${productUser.timezone}`} />
        <Field label="Joined" value={new Date(productUser.joinedAt).toLocaleString()} />
        <Field label="Last login" value={productUser.lastLoginAt ? new Date(productUser.lastLoginAt).toLocaleString() : '—'} />
        <Field label="Last IP" value={productUser.lastLoginIp ?? '—'} />
        <Field label="Failed login attempts" value={productUser.failedLoginAttempts} />
        <Field label="Locked until" value={productUser.lockedUntil ? new Date(productUser.lockedUntil).toLocaleString() : '—'} />
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Subscriptions</h2>
        <div className="card overflow-hidden p-0">
          {subscriptions.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No subscriptions.</p>
          ) : (
            <table className="table">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">ID</th>
                  <th className="th">Status</th>
                  <th className="th">Plan</th>
                  <th className="th">Subject</th>
                  <th className="th">Period end</th>
                  <th className="th">Bundle parent</th>
                  <th className="th">Cancel at end</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="td font-mono text-xs">{s.id}</td>
                    <td className="td"><StatusBadge status={s.status} /></td>
                    <td className="td text-xs">{s.planId}</td>
                    <td className="td text-xs">{s.subjectType}</td>
                    <td className="td text-xs">
                      {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—'}
                    </td>
                    <td className="td text-xs">{s.isBundleParent ? '✓' : ''}</td>
                    <td className="td text-xs">{s.cancelAtPeriodEnd ? '✓' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
