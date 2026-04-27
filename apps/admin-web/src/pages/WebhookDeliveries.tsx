import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, StatusBadge } from '../components/ui.js';

interface Delivery {
  _id: string;
  productId: string;
  event: string;
  status: string;
  url?: string;
  attemptCount: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  createdAt: string;
}

export function WebhookDeliveries() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');

  const list = useQuery({
    queryKey: ['webhook-deliveries', statusFilter],
    queryFn: () =>
      api<{ items: Delivery[]; nextCursor: string | null }>('GET', '/v1/admin/webhook-deliveries', {
        query: { status: statusFilter || undefined, limit: 50 },
      }),
  });

  const retry = useMutation({
    mutationFn: (id: string) =>
      api('POST', `/v1/admin/webhook-deliveries/${id}/retry`, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-deliveries'] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Webhook deliveries</h1>
        <select className="input max-w-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="DELIVERED">Delivered</option>
          <option value="FAILED">Failed</option>
          <option value="DEAD">Dead</option>
        </select>
      </div>

      <div className="card overflow-hidden p-0">
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading\u2026</p>}
        {list.data && (list.data.items.length === 0 ? <Empty>No deliveries.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Event</th>
                <th className="th">Status</th>
                <th className="th">Attempts</th>
                <th className="th">Next attempt</th>
                <th className="th">Last error</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.items.map((d) => (
                <tr key={d._id}>
                  <td className="td font-mono text-xs">{d.event}</td>
                  <td className="td"><StatusBadge status={d.status} /></td>
                  <td className="td">{d.attemptCount}</td>
                  <td className="td text-xs">{d.nextAttemptAt ?? '\u2014'}</td>
                  <td className="td text-xs text-rose-700 max-w-md truncate">{d.lastError ?? ''}</td>
                  <td className="td">
                    <Button variant="secondary" loading={retry.isPending && retry.variables === d._id} onClick={() => retry.mutate(d._id)}>
                      Retry
                    </Button>
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
