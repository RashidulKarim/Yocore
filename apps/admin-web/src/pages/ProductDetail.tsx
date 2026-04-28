import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, ErrorAlert, StatusBadge, InfoAlert, Input } from '../components/ui.js';
import { useState } from 'react';

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="label">{children}</p>;
}

interface BillingConfig {
  gracePeriodDays?: number;
  trialDefaultDays?: number;
  holdPeriodDays?: number;
  canReactivateDuringHold?: boolean;
  [key: string]: unknown;
}

interface Product {
  id: string;
  slug: string;
  name: string;
  status: string;
  apiKey: string;
  webhookUrl?: string | null;
  billingScope?: string;
  billingConfig?: BillingConfig;
  createdAt: string;
}

interface Gateway {
  id: string;
  provider: string;
  mode: string;
  status: string;
  displayName: string | null;
  lastVerificationStatus: 'ok' | 'failed' | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

type Provider = 'stripe' | 'sslcommerz';

const EMPTY_STRIPE = { secretKey: '', webhookSecret: '' };
const EMPTY_SSL = { storeId: '', storePassword: '', webhookSecret: '' };

export function ProductDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [secretInfo, setSecretInfo] = useState<string | null>(null);
  const [gwError, setGwError] = useState<string | null>(null);
  const [showGwForm, setShowGwForm] = useState(false);
  const [gwProvider, setGwProvider] = useState<Provider>('stripe');
  const [gwMode, setGwMode] = useState<'live' | 'test'>('test');
  const [stripe, setStripe] = useState(EMPTY_STRIPE);
  const [ssl, setSsl] = useState(EMPTY_SSL);

  const product = useQuery({
    queryKey: ['product', id],
    queryFn: () => api<{ product: Product }>('GET', `/v1/admin/products/${id}`),
    enabled: !!id,
  });

  const gateways = useQuery({
    queryKey: ['gateways', id],
    queryFn: () => api<{ gateways: Gateway[] }>('GET', `/v1/admin/products/${id}/gateways`),
    enabled: !!id,
  });

  const rotateApi = useMutation({
    mutationFn: () => api<{ apiSecret: string }>('POST', `/v1/admin/products/${id}/rotate-api-secret`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: (out) => setSecretInfo(`API secret rotated: ${out.apiSecret} (copy now \u2014 not shown again)`),
  });
  const rotateWebhook = useMutation({
    mutationFn: () => api<{ webhookSecret: string }>('POST', `/v1/admin/products/${id}/rotate-webhook-secret`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: (out) => setSecretInfo(`Webhook secret rotated: ${out.webhookSecret} (copy now)`),
  });
  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED') =>
      api('POST', `/v1/admin/products/${id}/status`, { body: { status }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['product', id] }),
  });

  const addGateway = useMutation({
    mutationFn: () => {
      const credentials = gwProvider === 'stripe'
        ? { secretKey: stripe.secretKey, webhookSecret: stripe.webhookSecret }
        : { storeId: ssl.storeId, storePassword: ssl.storePassword, ...(ssl.webhookSecret ? { webhookSecret: ssl.webhookSecret } : {}) };
      return api('POST', `/v1/admin/products/${id}/gateways`, {
        body: { provider: gwProvider, mode: gwMode, credentials },
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      setShowGwForm(false);
      setStripe(EMPTY_STRIPE);
      setSsl(EMPTY_SSL);
      setGwError(null);
      void qc.invalidateQueries({ queryKey: ['gateways', id] });
    },
    onError: (e) => setGwError((e as Error).message),
  });

  const removeGateway = useMutation({
    mutationFn: (gwId: string) => api('DELETE', `/v1/admin/products/${id}/gateways/${gwId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateways', id] }),
  });

  const [bcEdit, setBcEdit] = useState(false);
  const [bcGrace, setBcGrace] = useState('');
  const [bcTrial, setBcTrial] = useState('');
  const [bcHold, setBcHold] = useState('');
  const [bcInfo, setBcInfo] = useState<string | null>(null);
  const [bcError, setBcError] = useState<string | null>(null);
  const updateBillingConfig = useMutation({
    mutationFn: (body: Record<string, number>) =>
      api('PATCH', `/v1/admin/products/${id}/billing-config`, { body, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setBcInfo('Billing config updated');
      setBcEdit(false);
      void qc.invalidateQueries({ queryKey: ['product', id] });
    },
    onError: (e) => setBcError((e as Error).message),
  });

  if (product.isLoading) return <p className="text-sm text-slate-500">Loading\u2026</p>;
  if (product.error) return <ErrorAlert>{(product.error as Error).message}</ErrorAlert>;
  if (!product.data) return null;
  const p = product.data.product;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/products" className="text-xs text-slate-500 hover:underline">\u2190 Products</Link>
          <h1 className="text-2xl font-semibold mt-1">{p.name}</h1>
        </div>
        <StatusBadge status={p.status} />
      </div>

      {secretInfo && <InfoAlert>{secretInfo}</InfoAlert>}

      <div className="card space-y-2">
        <h2 className="font-medium">Identifiers</h2>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <dt className="text-slate-500">Slug</dt>
          <dd className="col-span-2 font-mono text-xs">{p.slug}</dd>
          <dt className="text-slate-500">API key</dt>
          <dd className="col-span-2 font-mono text-xs break-all">{p.apiKey}</dd>
          <dt className="text-slate-500">Webhook URL</dt>
          <dd className="col-span-2 font-mono text-xs">{p.webhookUrl ?? '\u2014'}</dd>
        </dl>
      </div>

      <div className="card space-y-3">
        <h2 className="font-medium">Operations</h2>
        <div className="flex flex-wrap gap-2">
          <Link to={`/products/${id}/users`} className="btn-secondary">View users</Link>
          <Link to={`/products/${id}/workspaces`} className="btn-secondary">View workspaces</Link>
          <Link to={`/products/${id}/roles`} className="btn-secondary">Roles & permissions</Link>
          <Link to={`/products/${id}/admins`} className="btn-secondary">Product admins</Link>
        </div>
      </div>

      <div className="card space-y-3">
        <h2 className="font-medium">Secrets</h2>
        <div className="flex gap-2">
          <Button variant="secondary" loading={rotateApi.isPending} onClick={() => rotateApi.mutate()}>Rotate API secret</Button>
          <Button variant="secondary" loading={rotateWebhook.isPending} onClick={() => rotateWebhook.mutate()}>Rotate webhook secret</Button>
        </div>
        <p className="text-xs text-slate-500">Webhook secret rotations keep the previous secret valid for 24h.</p>
      </div>

      <div className="card space-y-3">
        <h2 className="font-medium">Status</h2>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={p.status === 'ACTIVE'} onClick={() => setStatus.mutate('ACTIVE')}>Activate</Button>
          <Button variant="secondary" disabled={p.status === 'PAUSED'} onClick={() => setStatus.mutate('PAUSED')}>Pause</Button>
          <Button variant="danger" disabled={p.status === 'ARCHIVED'} onClick={() => setStatus.mutate('ARCHIVED')}>Archive</Button>
        </div>
      </div>

      {/* ── Billing config ───────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Billing config</h2>
          <Button variant="secondary" onClick={() => {
            const bc = p.billingConfig ?? {};
            setBcGrace(bc.gracePeriodDays != null ? String(bc.gracePeriodDays) : '');
            setBcTrial(bc.trialDefaultDays != null ? String(bc.trialDefaultDays) : '');
            setBcHold(bc.holdPeriodDays != null ? String(bc.holdPeriodDays) : '');
            setBcEdit((v) => !v);
            setBcError(null);
            setBcInfo(null);
          }}>
            {bcEdit ? 'Cancel' : 'Edit'}
          </Button>
        </div>
        <p className="text-xs text-slate-500">Billing scope: <span className="font-mono">{p.billingScope ?? 'workspace'}</span> (immutable)</p>
        {bcInfo && <InfoAlert>{bcInfo}</InfoAlert>}
        {bcError && <ErrorAlert>{bcError}</ErrorAlert>}
        {!bcEdit ? (
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <dt className="text-slate-500">Grace period (days)</dt>
            <dd className="col-span-2 font-mono text-xs">{p.billingConfig?.gracePeriodDays ?? '— (default 7)'}</dd>
            <dt className="text-slate-500">Trial default (days)</dt>
            <dd className="col-span-2 font-mono text-xs">{p.billingConfig?.trialDefaultDays ?? '— (no default)'}</dd>
            <dt className="text-slate-500">Hold period (days)</dt>
            <dd className="col-span-2 font-mono text-xs">{p.billingConfig?.holdPeriodDays ?? '— (default)'}</dd>
          </dl>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <FieldLabel>Grace period days</FieldLabel>
                <Input type="number" min={0} max={60} value={bcGrace} onChange={(e) => setBcGrace(e.target.value)} placeholder="7" />
              </div>
              <div>
                <FieldLabel>Trial default days</FieldLabel>
                <Input type="number" min={0} max={365} value={bcTrial} onChange={(e) => setBcTrial(e.target.value)} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Hold period days</FieldLabel>
                <Input type="number" min={1} max={365} value={bcHold} onChange={(e) => setBcHold(e.target.value)} placeholder="30" />
              </div>
            </div>
            <Button loading={updateBillingConfig.isPending} onClick={() => {
              const body: Record<string, number> = {};
              if (bcGrace !== '') body.gracePeriodDays = parseInt(bcGrace, 10);
              if (bcTrial !== '') body.trialDefaultDays = parseInt(bcTrial, 10);
              if (bcHold !== '') body.holdPeriodDays = parseInt(bcHold, 10);
              setBcError(null);
              updateBillingConfig.mutate(body);
            }}>
              Save
            </Button>
          </div>
        )}
      </div>

      {/* ── Payment Gateways ─────────────────────────────────────── */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Payment gateways</h2>
          <Button variant="secondary" onClick={() => { setShowGwForm((v) => !v); setGwError(null); }}>
            {showGwForm ? 'Cancel' : 'Add gateway'}
          </Button>
        </div>

        {gwError && <ErrorAlert>{gwError}</ErrorAlert>}

        {/* Add gateway form */}
        {showGwForm && (
          <div className="border rounded-lg p-4 space-y-4 bg-slate-50">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldLabel>Provider</FieldLabel>
                <select className="input w-full" value={gwProvider} onChange={(e) => setGwProvider(e.target.value as Provider)}>
                  <option value="stripe">Stripe</option>
                  <option value="sslcommerz">SSLCommerz</option>
                </select>
              </div>
              <div>
                <FieldLabel>Mode</FieldLabel>
                <select className="input w-full" value={gwMode} onChange={(e) => setGwMode(e.target.value as 'live' | 'test')}>
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              </div>
            </div>

            {gwProvider === 'stripe' && (
              <div className="space-y-3">
                <div>
                  <FieldLabel>Secret key <span className="text-slate-400">(sk_live_... or sk_test_...)</span></FieldLabel>
                  <Input value={stripe.secretKey} onChange={(e) => setStripe((s) => ({ ...s, secretKey: e.target.value }))} placeholder="sk_test_..." />
                </div>
                <div>
                  <FieldLabel>Webhook secret <span className="text-slate-400">(whsec_...)</span></FieldLabel>
                  <Input value={stripe.webhookSecret} onChange={(e) => setStripe((s) => ({ ...s, webhookSecret: e.target.value }))} placeholder="whsec_..." />
                  <p className="text-xs text-slate-500 mt-1">Run <code className="bg-slate-100 px-1 rounded">stripe listen --forward-to localhost:3000/v1/webhooks/stripe</code> to get a local webhook secret.</p>
                </div>
              </div>
            )}

            {gwProvider === 'sslcommerz' && (
              <div className="space-y-3">
                <div>
                  <FieldLabel>Store ID</FieldLabel>
                  <Input value={ssl.storeId} onChange={(e) => setSsl((s) => ({ ...s, storeId: e.target.value }))} placeholder="your_store_id" />
                </div>
                <div>
                  <FieldLabel>Store password</FieldLabel>
                  <Input type="password" value={ssl.storePassword} onChange={(e) => setSsl((s) => ({ ...s, storePassword: e.target.value }))} placeholder="••••••••" />
                </div>
                <div>
                  <FieldLabel>Webhook secret <span className="text-slate-400">(optional)</span></FieldLabel>
                  <Input value={ssl.webhookSecret} onChange={(e) => setSsl((s) => ({ ...s, webhookSecret: e.target.value }))} />
                </div>
              </div>
            )}

            <Button loading={addGateway.isPending} onClick={() => addGateway.mutate()}>
              Save & verify
            </Button>
          </div>
        )}

        {/* Gateway list */}
        {gateways.isLoading && <p className="text-sm text-slate-500">Loading\u2026</p>}
        {gateways.data && gateways.data.gateways.length === 0 && !showGwForm && (
          <p className="text-sm text-slate-500">No gateways configured yet.</p>
        )}
        {gateways.data && gateways.data.gateways.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th className="th">Provider</th>
                <th className="th">Mode</th>
                <th className="th">Status</th>
                <th className="th">Verification</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {gateways.data.gateways.map((gw) => (
                <tr key={gw.id}>
                  <td className="td font-medium capitalize">{gw.provider}</td>
                  <td className="td text-xs">{gw.mode}</td>
                  <td className="td"><StatusBadge status={gw.status} /></td>
                  <td className="td text-xs">
                    {gw.lastVerificationStatus === 'ok' && <span className="text-emerald-600">✓ Verified</span>}
                    {gw.lastVerificationStatus === 'failed' && <span className="text-rose-600">✗ Failed</span>}
                    {!gw.lastVerificationStatus && <span className="text-slate-400">—</span>}
                  </td>
                  <td className="td text-right">
                    <Button variant="danger" loading={removeGateway.isPending} onClick={() => removeGateway.mutate(gw.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
