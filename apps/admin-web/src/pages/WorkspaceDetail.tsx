import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ErrorAlert, StatusBadge } from '../components/ui.js';

interface WorkspaceDetailResponse {
  workspace: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    status: string;
    suspended: boolean;
    suspensionDate: string | null;
    suspensionReason: string | null;
    ownerUserId: string;
    ownerEmail: string | null;
    billingContactUserId: string;
    timezone: string;
    settings: Record<string, unknown>;
    trialConverted: boolean;
    dataDeleted: boolean;
    dataDeletedAt: string | null;
    voluntaryDeletionRequestedAt: string | null;
    voluntaryDeletionFinalizesAt: string | null;
    createdAt: string;
  };
  subscriptions: Array<{
    id: string;
    status: string;
    planId: string;
    bundleId: string | null;
    isBundleParent: boolean;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
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

export function WorkspaceDetailPage() {
  const { productId = '', workspaceId = '' } = useParams<{
    productId: string;
    workspaceId: string;
  }>();
  const detail = useQuery({
    queryKey: ['admin', 'workspace-detail', productId, workspaceId],
    queryFn: () =>
      api<WorkspaceDetailResponse>(
        'GET',
        `/v1/admin/products/${productId}/workspaces/${workspaceId}`,
      ),
    enabled: !!productId && !!workspaceId,
  });

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (detail.error) return <ErrorAlert>{(detail.error as Error).message}</ErrorAlert>;
  if (!detail.data) return null;
  const { workspace, subscriptions } = detail.data;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/products/${productId}/workspaces`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← All workspaces
        </Link>
        <h1 className="text-2xl font-semibold mt-2">{workspace.name}</h1>
        <p className="text-sm text-slate-500 font-mono">{workspace.slug}</p>
      </div>

      <div className="card grid grid-cols-2 md:grid-cols-3 gap-4">
        <Field label="Status" value={<StatusBadge status={workspace.status} />} />
        <Field label="Suspended" value={workspace.suspended ? `Yes (${workspace.suspensionReason ?? '—'})` : 'No'} />
        <Field label="Owner email" value={workspace.ownerEmail ?? workspace.ownerUserId} />
        <Field label="Owner ID" value={<span className="font-mono text-xs">{workspace.ownerUserId}</span>} />
        <Field label="Billing contact" value={<span className="font-mono text-xs">{workspace.billingContactUserId}</span>} />
        <Field label="Timezone" value={workspace.timezone} />
        <Field label="Trial converted" value={workspace.trialConverted ? 'Yes' : 'No'} />
        <Field label="Created" value={new Date(workspace.createdAt).toLocaleString()} />
        <Field label="Suspension date" value={workspace.suspensionDate ? new Date(workspace.suspensionDate).toLocaleString() : '—'} />
        <Field label="Voluntary deletion req" value={workspace.voluntaryDeletionRequestedAt ? new Date(workspace.voluntaryDeletionRequestedAt).toLocaleString() : '—'} />
        <Field label="Finalizes at" value={workspace.voluntaryDeletionFinalizesAt ? new Date(workspace.voluntaryDeletionFinalizesAt).toLocaleString() : '—'} />
        <Field label="Data deleted" value={workspace.dataDeletedAt ? new Date(workspace.dataDeletedAt).toLocaleString() : 'No'} />
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
                  <th className="th">Bundle</th>
                  <th className="th">Period end</th>
                  <th className="th">Cancel at end</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="td font-mono text-xs">{s.id}</td>
                    <td className="td"><StatusBadge status={s.status} /></td>
                    <td className="td text-xs">{s.planId}</td>
                    <td className="td text-xs">{s.bundleId ?? '—'}{s.isBundleParent && <span className="badge-slate ml-1">PARENT</span>}</td>
                    <td className="td text-xs">{s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '—'}</td>
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
