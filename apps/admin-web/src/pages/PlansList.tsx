import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input, Label, StatusBadge } from '../components/ui.js';

interface Plan {
  id: string;
  productId: string;
  slug: string;
  name: string;
  status: string;
  amount: number;
  currency: string;
  interval: string;
  trialDays: number;
  seatBased: boolean;
  perSeatAmount: number | null;
  includedSeats: number | null;
  limits: Record<string, unknown>;
}
interface Product { id: string; name: string; slug: string }

const CURRENCIES = ['usd', 'eur', 'gbp', 'bdt', 'inr', 'sgd'];
const INTERVALS = ['month', 'year', 'one_time'];

const EMPTY_FORM = {
  name: '', slug: '', isFree: false,
  amountMajor: '', currency: 'usd', interval: 'month', trialDays: '0',
  seatBased: false, perSeatAmountMajor: '', includedSeats: '',
  maxMembers: '',
};

function toMinor(major: string, currency: string): number {
  const n = parseFloat(major || '0');
  if (Number.isNaN(n)) return 0;
  // Zero-decimal currencies (JPY, KRW etc.) — none in our list, all use 2 decimals.
  void currency;
  return Math.round(n * 100);
}

function fromMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function PlansList() {
  const qc = useQueryClient();
  const [productId, setProductId] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api<{ products: Product[] }>('GET', '/v1/admin/products'),
  });
  const plans = useQuery({
    queryKey: ['plans', productId],
    queryFn: () => api<{ plans: Plan[] }>('GET', `/v1/admin/products/${productId}/plans`),
    enabled: !!productId,
  });

  const resetForm = () => {
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const buildBody = () => {
    const body: Record<string, unknown> = {
      name: form.name,
      isFree: form.isFree,
      amount: form.isFree ? 0 : toMinor(form.amountMajor, form.currency),
      trialDays: parseInt(form.trialDays || '0', 10),
      seatBased: form.seatBased,
    };
    if (form.seatBased) {
      body.perSeatAmount = toMinor(form.perSeatAmountMajor, form.currency);
      if (form.includedSeats) body.includedSeats = parseInt(form.includedSeats, 10);
    }
    if (form.maxMembers) {
      body.limits = { maxMembers: parseInt(form.maxMembers, 10) };
    }
    if (!editId) {
      // Create-only fields
      body.slug = form.slug;
      body.currency = form.currency;
      body.interval = form.interval;
    }
    return body;
  };

  const create = useMutation({
    mutationFn: () =>
      api('POST', `/v1/admin/products/${productId}/plans`, { body: buildBody(), idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => { resetForm(); void qc.invalidateQueries({ queryKey: ['plans', productId] }); },
    onError: (e) => setError((e as Error).message),
  });

  const update = useMutation({
    mutationFn: () =>
      api('PATCH', `/v1/admin/products/${productId}/plans/${editId}`, { body: buildBody(), idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => { resetForm(); void qc.invalidateQueries({ queryKey: ['plans', productId] }); },
    onError: (e) => setError((e as Error).message),
  });

  const publish = useMutation({
    mutationFn: (planId: string) =>
      api('POST', `/v1/admin/products/${productId}/plans/${planId}/publish`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans', productId] }),
  });
  const archive = useMutation({
    mutationFn: (planId: string) =>
      api('POST', `/v1/admin/products/${productId}/plans/${planId}/archive`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans', productId] }),
  });

  const startEdit = (plan: Plan) => {
    setEditId(plan.id);
    setShowForm(true);
    setError(null);
    setForm({
      name: plan.name,
      slug: plan.slug,
      isFree: plan.amount === 0,
      amountMajor: fromMinor(plan.amount),
      currency: plan.currency,
      interval: plan.interval,
      trialDays: String(plan.trialDays ?? 0),
      seatBased: plan.seatBased,
      perSeatAmountMajor: plan.perSeatAmount != null ? fromMinor(plan.perSeatAmount) : '',
      includedSeats: plan.includedSeats != null ? String(plan.includedSeats) : '',
      maxMembers: typeof plan.limits?.maxMembers === 'number' ? String(plan.limits.maxMembers) : '',
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Billing plans</h1>
        {productId && !editId && (
          <Button onClick={() => { if (showForm) resetForm(); else { setShowForm(true); setForm(EMPTY_FORM); } }}>
            {showForm ? 'Cancel' : 'New plan'}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">Product:</label>
        <select className="input max-w-xs" value={productId} onChange={(e) => { setProductId(e.target.value); resetForm(); }}>
          <option value="">— select —</option>
          {products.data?.products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {showForm && (
        <div className="card space-y-4">
          <h2 className="font-semibold">{editId ? 'Edit plan' : 'Create plan'}</h2>
          {error && <ErrorAlert>{error}</ErrorAlert>}
          {editId && (
            <p className="text-xs text-slate-500">
              Editing a published plan only allows changing name, description, trial, seats, and limits.
              Amount/currency/interval are immutable once published.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="pname">Name</Label>
              <Input id="pname" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Pro" />
            </div>
            <div>
              <Label htmlFor="pslug">Slug</Label>
              <Input id="pslug" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="pro" disabled={!!editId} />
            </div>
            <div>
              <Label htmlFor="pamount">Amount ({form.currency.toUpperCase()})</Label>
              <Input id="pamount" type="number" step="0.01" value={form.amountMajor} onChange={(e) => setForm((f) => ({ ...f, amountMajor: e.target.value }))} placeholder="19.99" disabled={form.isFree} />
              <p className="text-xs text-slate-500 mt-1">e.g. 19.99 = $19.99 (stored as minor units / cents)</p>
            </div>
            <div>
              <Label htmlFor="pcurrency">Currency</Label>
              <select id="pcurrency" className="input w-full" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} disabled={!!editId}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="pinterval">Billing interval</Label>
              <select id="pinterval" className="input w-full" value={form.interval} onChange={(e) => setForm((f) => ({ ...f, interval: e.target.value }))} disabled={!!editId}>
                {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="ptrial">Trial days</Label>
              <Input id="ptrial" type="number" value={form.trialDays} onChange={(e) => setForm((f) => ({ ...f, trialDays: e.target.value }))} placeholder="0" />
            </div>
            <div>
              <Label htmlFor="pmax">Max members (-1 = unlimited)</Label>
              <Input id="pmax" type="number" value={form.maxMembers} onChange={(e) => setForm((f) => ({ ...f, maxMembers: e.target.value }))} placeholder="leave blank for default" />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isFree} onChange={(e) => setForm((f) => ({ ...f, isFree: e.target.checked, amountMajor: e.target.checked ? '0' : f.amountMajor }))} />
            Free plan (no charge)
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.seatBased} onChange={(e) => setForm((f) => ({ ...f, seatBased: e.target.checked }))} />
            Per-seat billing
          </label>

          {form.seatBased && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="pseatamt">Per-seat amount ({form.currency.toUpperCase()})</Label>
                <Input id="pseatamt" type="number" step="0.01" value={form.perSeatAmountMajor} onChange={(e) => setForm((f) => ({ ...f, perSeatAmountMajor: e.target.value }))} placeholder="5.00" />
              </div>
              <div>
                <Label htmlFor="pseatinc">Included seats</Label>
                <Input id="pseatinc" type="number" value={form.includedSeats} onChange={(e) => setForm((f) => ({ ...f, includedSeats: e.target.value }))} placeholder="1" />
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              loading={create.isPending || update.isPending}
              onClick={() => { setError(null); (editId ? update : create).mutate(); }}
            >
              {editId ? 'Save changes' : 'Create plan'}
            </Button>
            <Button variant="secondary" onClick={resetForm}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        {plans.error && <div className="p-4"><ErrorAlert>{(plans.error as Error).message}</ErrorAlert></div>}
        {!productId && <Empty>Select a product to view its plans.</Empty>}
        {productId && plans.isLoading && <p className="p-4 text-sm text-slate-500">Loading…</p>}
        {plans.data && (plans.data.plans.length === 0 ? <Empty>No plans yet. Click "New plan" to create one.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Slug</th>
                <th className="th">Price</th>
                <th className="th">Seat</th>
                <th className="th">Interval</th>
                <th className="th">Status</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {plans.data.plans.map((p) => (
                <tr key={p.id}>
                  <td className="td font-medium">{p.name}</td>
                  <td className="td font-mono text-xs">{p.slug}</td>
                  <td className="td">{p.amount === 0 ? 'Free' : `${fromMinor(p.amount)} ${p.currency.toUpperCase()}`}</td>
                  <td className="td text-xs">{p.seatBased && p.perSeatAmount != null ? `+${fromMinor(p.perSeatAmount)}/seat` : '—'}</td>
                  <td className="td">{p.interval}</td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td text-right space-x-2">
                    {p.status === 'DRAFT' && (
                      <>
                        <Button variant="secondary" onClick={() => startEdit(p)}>Edit</Button>
                        <Button loading={publish.isPending && publish.variables === p.id} onClick={() => publish.mutate(p.id)}>Publish</Button>
                      </>
                    )}
                    {p.status === 'ACTIVE' && (
                      <>
                        <Button variant="secondary" onClick={() => startEdit(p)}>Edit</Button>
                        <Button variant="danger" loading={archive.isPending && archive.variables === p.id} onClick={() => archive.mutate(p.id)}>Archive</Button>
                      </>
                    )}
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

