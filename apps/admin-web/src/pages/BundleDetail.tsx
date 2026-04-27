import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Button, ErrorAlert, Input, Label, StatusBadge } from '../components/ui.js';

interface Bundle {
  id: string;
  productId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  components: Array<{ planId: string; productId: string }>;
  pricing: Array<{ currency: string; amount: number }>;
  interval: string;
  eligibilityPolicy: string;
  changeHistory?: Array<{
    changedAt: string;
    type: string;
    reason?: string;
    before?: unknown;
    after?: unknown;
  }>;
  createdAt: string;
  publishedAt?: string | null;
  archivedAt?: string | null;
}

const TABS = [
  'overview',
  'components',
  'pricing',
  'eligibility',
  'history',
  'danger',
] as const;
type Tab = (typeof TABS)[number];

export function BundleDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['admin', 'bundle', id],
    queryFn: () => api<{ bundle: Bundle }>('GET', `/v1/admin/bundles/${id}`),
    enabled: !!id,
  });

  const publish = useMutation({
    mutationFn: () => api('POST', `/v1/admin/bundles/${id}/publish`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'bundle', id] }),
    onError: (e) => setError((e as Error).message),
  });
  const archive = useMutation({
    mutationFn: () => api('POST', `/v1/admin/bundles/${id}/archive`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'bundle', id] }),
    onError: (e) => setError((e as Error).message),
  });
  const del = useMutation({
    mutationFn: () => api('DELETE', `/v1/admin/bundles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'bundles'] }),
    onError: (e) => setError((e as Error).message),
  });

  // Component-swap form
  const [swapIdx, setSwapIdx] = useState('0');
  const [swapPlan, setSwapPlan] = useState('');
  const [swapPolicy, setSwapPolicy] = useState<'grandfather' | 'forced_migrate'>('grandfather');
  const swap = useMutation({
    mutationFn: () =>
      api('POST', `/v1/admin/bundles/${id}/swap-component`, {
        body: {
          componentIndex: parseInt(swapIdx, 10),
          newPlanId: swapPlan,
          applyPolicy: swapPolicy,
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setSwapPlan('');
      void qc.invalidateQueries({ queryKey: ['admin', 'bundle', id] });
    },
    onError: (e) => setError((e as Error).message),
  });

  if (detail.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (detail.error) return <ErrorAlert>{(detail.error as Error).message}</ErrorAlert>;
  if (!detail.data) return null;
  const b = detail.data.bundle;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/bundles" className="text-sm text-brand-700 hover:underline">← All bundles</Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{b.name}</h1>
          <StatusBadge status={b.status} />
        </div>
        <p className="text-sm text-slate-500 font-mono">{b.slug}</p>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      <nav className="border-b border-slate-200 flex gap-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm capitalize ${
              tab === t
                ? 'border-b-2 border-brand-600 text-brand-700 font-medium'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="card grid grid-cols-2 gap-4">
          <Field label="Status" value={<StatusBadge status={b.status} />} />
          <Field label="Visibility" value={b.visibility} />
          <Field label="Interval" value={b.interval} />
          <Field label="Created" value={new Date(b.createdAt).toLocaleString()} />
          <Field label="Published" value={b.publishedAt ? new Date(b.publishedAt).toLocaleString() : '—'} />
          <Field label="Archived" value={b.archivedAt ? new Date(b.archivedAt).toLocaleString() : '—'} />
          <div className="col-span-2">
            <Field label="Description" value={b.description ?? '—'} />
          </div>
        </div>
      )}

      {tab === 'components' && (
        <>
          <div className="card overflow-hidden p-0">
            <table className="table">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Component product</th>
                  <th className="th">Plan ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {b.components.map((c, i) => (
                  <tr key={i}>
                    <td className="td">{i}</td>
                    <td className="td font-mono text-xs">{c.productId}</td>
                    <td className="td font-mono text-xs">{c.planId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card space-y-3">
            <h3 className="text-sm font-semibold">Swap component plan (Flow AM)</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="sw-idx">Component index</Label>
                <Input id="sw-idx" value={swapIdx} onChange={(e) => setSwapIdx(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="sw-plan">New plan ID</Label>
                <Input id="sw-plan" value={swapPlan} onChange={(e) => setSwapPlan(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="sw-pol">Policy</Label>
                <select
                  id="sw-pol"
                  className="input w-full"
                  value={swapPolicy}
                  onChange={(e) => setSwapPolicy(e.target.value as 'grandfather' | 'forced_migrate')}
                >
                  <option value="grandfather">Grandfather existing</option>
                  <option value="forced_migrate">Force migrate active children</option>
                </select>
              </div>
            </div>
            <Button
              loading={swap.isPending}
              disabled={!swapPlan || b.status !== 'ACTIVE'}
              onClick={() => {
                setError(null);
                swap.mutate();
              }}
            >
              Swap component
            </Button>
            {b.status !== 'ACTIVE' && (
              <p className="text-xs text-slate-500">Bundle must be ACTIVE to swap components.</p>
            )}
          </div>
        </>
      )}

      {tab === 'pricing' && (
        <div className="card overflow-hidden p-0">
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Currency</th>
                <th className="th">Amount (major)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {b.pricing.map((p) => (
                <tr key={p.currency}>
                  <td className="td">{p.currency.toUpperCase()}</td>
                  <td className="td">{(p.amount / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'eligibility' && (
        <div className="card">
          <Field label="Eligibility policy" value={b.eligibilityPolicy} />
          <p className="text-xs text-slate-500 mt-2">
            Controls what happens when a user already has a standalone subscription to a component
            product when subscribing to this bundle.
          </p>
        </div>
      )}

      {tab === 'history' && (
        <div className="card overflow-hidden p-0">
          {!b.changeHistory || b.changeHistory.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No history.</p>
          ) : (
            <table className="table">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">When</th>
                  <th className="th">Type</th>
                  <th className="th">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {b.changeHistory.map((h, i) => (
                  <tr key={i}>
                    <td className="td text-xs">{new Date(h.changedAt).toLocaleString()}</td>
                    <td className="td text-xs">{h.type}</td>
                    <td className="td text-xs">{h.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'danger' && (
        <div className="card space-y-4">
          <div className="flex gap-3">
            <Button onClick={() => publish.mutate()} loading={publish.isPending} disabled={b.status === 'ACTIVE'}>
              Publish
            </Button>
            <Button variant="secondary" onClick={() => archive.mutate()} loading={archive.isPending} disabled={b.status === 'ARCHIVED'}>
              Archive
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm('Delete this bundle? Only allowed if it has no active subscriptions.')) {
                  del.mutate();
                }
              }}
              loading={del.isPending}
              disabled={b.status === 'ACTIVE'}
            >
              Delete
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Publishing makes the bundle visible at /v1/billing/bundles. Archive hides it from new
            checkouts; existing subscriptions continue. Deletion only allowed for DRAFT/ARCHIVED with
            no active subscribers.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm mt-0.5">{value ?? '—'}</div>
    </div>
  );
}
