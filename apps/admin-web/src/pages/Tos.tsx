import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input, Label, StatusBadge } from '../components/ui.js';

interface TosVersion {
  _id: string;
  type: 'terms_of_service' | 'privacy_policy';
  version: string;
  effectiveAt: string;
  contentUrl: string;
  contentHash: string;
  isCurrent: boolean;
  changeSummary?: string;
}

export function TosPage() {
  const qc = useQueryClient();
  const [type, setType] = useState<'terms_of_service' | 'privacy_policy'>('terms_of_service');
  const [version, setVersion] = useState('');
  const [contentUrl, setContentUrl] = useState('');
  const [contentHash, setContentHash] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['tos'],
    queryFn: () => api<{ versions: TosVersion[] }>('GET', '/v1/admin/tos'),
  });

  const publish = useMutation({
    mutationFn: () =>
      api('POST', '/v1/admin/tos', {
        body: {
          type,
          version,
          effectiveAt: new Date().toISOString(),
          contentUrl,
          contentHash,
          changeSummary: changeSummary || undefined,
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setVersion('');
      setContentUrl('');
      setContentHash('');
      setChangeSummary('');
      void qc.invalidateQueries({ queryKey: ['tos'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Terms of Service / Privacy Policy</h1>

      <div className="card max-w-2xl space-y-4">
        <h2 className="font-medium">Publish a new version</h2>
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <div>
          <Label htmlFor="type">Type</Label>
          <select id="type" className="input" value={type} onChange={(e) => setType(e.target.value as 'terms_of_service' | 'privacy_policy')}>
            <option value="terms_of_service">Terms of Service</option>
            <option value="privacy_policy">Privacy Policy</option>
          </select>
        </div>
        <div>
          <Label htmlFor="version">Version</Label>
          <Input id="version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0" />
        </div>
        <div>
          <Label htmlFor="url">Content URL</Label>
          <Input id="url" value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} placeholder="https://example.com/tos/1.0" />
        </div>
        <div>
          <Label htmlFor="hash">Content hash (SHA-256, hex)</Label>
          <Input id="hash" value={contentHash} onChange={(e) => setContentHash(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="summary">Change summary (optional)</Label>
          <Input id="summary" value={changeSummary} onChange={(e) => setChangeSummary(e.target.value)} />
        </div>
        <Button loading={publish.isPending} onClick={() => { setError(null); publish.mutate(); }}>Publish</Button>
      </div>

      <div className="card overflow-hidden p-0">
        <h2 className="font-medium px-6 pt-6 pb-2">Published versions</h2>
        {list.error && <div className="p-4"><ErrorAlert>{(list.error as Error).message}</ErrorAlert></div>}
        {list.isLoading && <p className="p-4 text-sm text-slate-500">Loading\u2026</p>}
        {list.data && (list.data.versions.length === 0 ? <Empty>No versions yet.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Type</th>
                <th className="th">Version</th>
                <th className="th">Effective at</th>
                <th className="th">Current</th>
                <th className="th">URL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.versions.map((v) => (
                <tr key={v._id}>
                  <td className="td">{v.type === 'terms_of_service' ? 'ToS' : 'Privacy'}</td>
                  <td className="td font-mono text-xs">{v.version}</td>
                  <td className="td text-xs">{new Date(v.effectiveAt).toLocaleString()}</td>
                  <td className="td">{v.isCurrent && <StatusBadge status="ACTIVE" />}</td>
                  <td className="td text-xs"><a href={v.contentUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">View</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
