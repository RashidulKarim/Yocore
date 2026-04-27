import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, ErrorAlert, InfoAlert } from '../components/ui.js';

interface SuperAdminConfig {
  adminIpAllowlist: string[];
  adminIpAllowlistEnabled: boolean;
  jwtSigningKey?: { kid?: string; activatedAt?: string } | null;
}

export function SuperAdminSettings() {
  const qc = useQueryClient();
  const [allowlistText, setAllowlistText] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cfg = useQuery({
    queryKey: ['super-admin-config'],
    queryFn: () => api<SuperAdminConfig>('GET', '/v1/admin/super-admin/config'),
  });

  useEffect(() => {
    if (cfg.data) {
      setAllowlistText(cfg.data.adminIpAllowlist.join('\n'));
      setEnabled(cfg.data.adminIpAllowlistEnabled);
    }
  }, [cfg.data]);

  const update = useMutation({
    mutationFn: () =>
      api('PATCH', '/v1/admin/super-admin/config', {
        body: {
          adminIpAllowlist: allowlistText.split('\n').map((l) => l.trim()).filter(Boolean),
          adminIpAllowlistEnabled: enabled,
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setInfo('Configuration updated.');
      void qc.invalidateQueries({ queryKey: ['super-admin-config'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const rotate = useMutation({
    mutationFn: () => api<{ kid: string }>('POST', '/v1/admin/jwt/rotate-key', { idempotencyKey: crypto.randomUUID() }),
    onSuccess: (out) => setInfo(`JWT signing key rotated. New kid: ${out.kid}`),
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Super Admin settings</h1>
      {info && <InfoAlert>{info}</InfoAlert>}
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <section className="card max-w-2xl space-y-4">
        <h2 className="font-medium">IP allowlist</h2>
        <p className="text-sm text-slate-600">
          Restrict super-admin endpoints to these CIDRs. One entry per line.
          See the <code className="font-mono text-xs">ip-allowlist-recovery</code> runbook
          before enabling in production.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable allowlist enforcement
        </label>
        <textarea
          className="input min-h-32 font-mono text-xs"
          value={allowlistText}
          onChange={(e) => setAllowlistText(e.target.value)}
          placeholder={'10.0.0.0/8\n203.0.113.5/32'}
        />
        <Button loading={update.isPending} onClick={() => { setError(null); setInfo(null); update.mutate(); }}>
          Save
        </Button>
      </section>

      <section className="card max-w-2xl space-y-3">
        <h2 className="font-medium">JWT signing keys</h2>
        <p className="text-sm text-slate-600">
          Rotation generates a new EdDSA key. The previous key remains valid for 30 minutes
          to allow inflight tokens to verify (ADR-006).
        </p>
        <Button variant="danger" loading={rotate.isPending} onClick={() => { setError(null); rotate.mutate(); }}>
          Rotate JWT signing key
        </Button>
      </section>
    </div>
  );
}
