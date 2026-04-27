import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input, Label, StatusBadge } from '../components/ui.js';

interface Bundle {
  id: string;
  productId: string;
  slug: string;
  name: string;
  status: string;
  components: Array<{ planId: string; productId: string }>;
  pricing: Array<{ currency: string; amount: number }>;
  interval: string;
  eligibilityPolicy: string;
  visibility: string;
  createdAt: string;
}

const EMPTY = {
  productId: '',
  name: '',
  slug: '',
  description: '',
  interval: 'month' as 'month' | 'year',
  pricing: '0',
  currency: 'usd',
  eligibilityPolicy: 'block' as 'block' | 'cancel_and_credit' | 'replace_immediately',
  components: '', // comma-separated planIds
};

export function BundlesListPage() {
  const qc = useQueryClient();
  const [productFilter, setProductFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api<{ products: Array<{ id: string; name: string }> }>('GET', '/v1/admin/products'),
  });

  const list = useQuery({
    queryKey: ['admin', 'bundles', productFilter],
    queryFn: () =>
      api<{ bundles: Bundle[] }>('GET', '/v1/admin/bundles', {
        query: { productId: productFilter || undefined, limit: 100 },
      }),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('POST', '/v1/admin/bundles', { body, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setShowForm(false);
      setForm(EMPTY);
      void qc.invalidateQueries({ queryKey: ['admin', 'bundles'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bundles</h1>
        <Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New bundle'}</Button>
      </div>

      <div className="card flex items-end gap-3">
        <div>
          <Label htmlFor="filter">Filter by parent product</Label>
          <select
            id="filter"
            className="input"
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
          >
            <option value="">All products</option>
            {products.data?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showForm && (
        <div className="card space-y-4">
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="b-product">Parent product</Label>
              <select
                id="b-product"
                className="input w-full"
                value={form.productId}
                onChange={(e) => setForm({ ...form, productId: e.target.value })}
              >
                <option value="">Select…</option>
                {products.data?.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="b-name">Name</Label>
              <Input id="b-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-slug">Slug</Label>
              <Input id="b-slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-interval">Interval</Label>
              <select
                id="b-interval"
                className="input w-full"
                value={form.interval}
                onChange={(e) => setForm({ ...form, interval: e.target.value as 'month' | 'year' })}
              >
                <option value="month">Monthly</option>
                <option value="year">Yearly</option>
              </select>
            </div>
            <div>
              <Label htmlFor="b-amount">Amount (major)</Label>
              <Input id="b-amount" value={form.pricing} onChange={(e) => setForm({ ...form, pricing: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="b-currency">Currency</Label>
              <select
                id="b-currency"
                className="input w-full"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              >
                {['usd', 'eur', 'gbp', 'bdt', 'inr', 'sgd'].map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="b-elig">Eligibility policy</Label>
              <select
                id="b-elig"
                className="input w-full"
                value={form.eligibilityPolicy}
                onChange={(e) => setForm({ ...form, eligibilityPolicy: e.target.value as 'block' | 'cancel_and_credit' | 'replace_immediately' })}
              >
                <option value="block">Block (have to cancel first)</option>
                <option value="cancel_and_credit">Cancel + credit</option>
                <option value="replace_immediately">Replace immediately</option>
              </select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="b-components">Component plan IDs (comma-separated, ≥2)</Label>
              <Input id="b-components" value={form.components} onChange={(e) => setForm({ ...form, components: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="b-desc">Description</Label>
              <Input id="b-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <Button
            loading={create.isPending}
            onClick={() => {
              setError(null);
              const planIds = form.components.split(',').map((s) => s.trim()).filter(Boolean);
              create.mutate({
                productId: form.productId,
                name: form.name,
                slug: form.slug,
                description: form.description,
                interval: form.interval,
                pricing: [{ currency: form.currency, amount: Math.round(parseFloat(form.pricing || '0') * 100) }],
                eligibilityPolicy: form.eligibilityPolicy,
                components: planIds.map((planId) => ({ planId })),
              });
            }}
          >
            Create bundle (DRAFT)
          </Button>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {list.data && (list.data.bundles.length === 0 ? <Empty>No bundles.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Slug</th>
                <th className="th">Status</th>
                <th className="th">Components</th>
                <th className="th">Visibility</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.bundles.map((b) => (
                <tr key={b.id}>
                  <td className="td">{b.name}</td>
                  <td className="td font-mono text-xs">{b.slug}</td>
                  <td className="td"><StatusBadge status={b.status} /></td>
                  <td className="td text-xs">{b.components.length}</td>
                  <td className="td text-xs">{b.visibility}</td>
                  <td className="td">
                    <Link to={`/bundles/${b.id}`} className="text-brand-700 text-sm hover:underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
