import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input, Label, StatusBadge } from '../components/ui.js';

interface Product {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt: string;
}

export function ProductsList() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [billingScope, setBillingScope] = useState<'workspace' | 'user'>('workspace');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['products'],
    queryFn: () => api<{ products: Product[] }>('GET', '/v1/admin/products'),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; slug: string; billingScope: 'workspace' | 'user' }) =>
      api('POST', '/v1/admin/products', { body, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setShowForm(false);
      setName('');
      setSlug('');
      setBillingScope('workspace');
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Products</h1>
        <Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New product'}</Button>
      </div>

      {showForm && (
        <div className="card space-y-4">
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="billingScope">Billing scope</Label>
            <select
              id="billingScope"
              className="input w-full"
              value={billingScope}
              onChange={(e) => setBillingScope(e.target.value as 'workspace' | 'user')}
            >
              <option value="workspace">Workspace (subscription belongs to a workspace)</option>
              <option value="user">User (subscription belongs to a user)</option>
            </select>
            <p className="text-xs text-slate-500 mt-1">Cannot be changed after creation.</p>
          </div>
          <Button
            loading={create.isPending}
            onClick={() => {
              setError(null);
              create.mutate({ name, slug, billingScope });
            }}
          >
            Create
          </Button>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading\u2026</p>}
        {list.data && (list.data.products.length === 0 ? <Empty>No products yet.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Name</th>
                <th className="th">Slug</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.products.map((p) => (
                <tr key={p.id}>
                  <td className="td font-medium">{p.name}</td>
                  <td className="td font-mono text-xs">{p.slug}</td>
                  <td className="td"><StatusBadge status={p.status} /></td>
                  <td className="td text-xs">{new Date(p.createdAt).toLocaleString()}</td>
                  <td className="td"><Link to={`/products/${p.id}`} className="text-brand-600 hover:underline">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
