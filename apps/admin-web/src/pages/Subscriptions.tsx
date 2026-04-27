import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, ErrorAlert, InfoAlert, Input, Label } from '../components/ui.js';

const STATUSES = ['ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED', 'TRIALING', 'INCOMPLETE'] as const;

export function Subscriptions() {
  const [productId, setProductId] = useState('');
  const [subscriptionId, setSubscriptionId] = useState('');
  const [status, setStatus] = useState<typeof STATUSES[number]>('ACTIVE');
  const [reason, setReason] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const force = useMutation({
    mutationFn: () =>
      api(
        'POST',
        `/v1/admin/products/${productId}/subscriptions/${subscriptionId}/force-status`,
        {
          body: { status, reason },
          idempotencyKey: crypto.randomUUID(),
        },
      ),
    onSuccess: () => {
      setInfo(`Subscription ${subscriptionId} forced to ${status}.`);
      setError(null);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Subscriptions</h1>
      <p className="text-sm text-slate-600">
        Force a subscription status (super-admin override). Leaves an audit-log record.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}
      {info && <InfoAlert>{info}</InfoAlert>}

      <div className="card max-w-xl space-y-4">
        <div>
          <Label htmlFor="pid">Product ID</Label>
          <Input id="pid" value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="prd_..." />
        </div>
        <div>
          <Label htmlFor="sid">Subscription ID</Label>
          <Input id="sid" value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)} placeholder="sub_..." />
        </div>
        <div>
          <Label htmlFor="st">Target status</Label>
          <select id="st" className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof STATUSES[number])}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <Label htmlFor="reason">Reason</Label>
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this override needed?" />
        </div>
        <Button
          variant="danger"
          loading={force.isPending}
          disabled={!productId || !subscriptionId || !reason}
          onClick={() => force.mutate()}
        >
          Force status
        </Button>
      </div>
    </div>
  );
}
