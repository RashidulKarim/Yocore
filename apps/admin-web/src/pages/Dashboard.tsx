import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { ErrorAlert } from '../components/ui.js';

interface CronJob { jobName: string; dateKey: string; lockedAt?: string; completedAt?: string | null; error?: string | null }
interface CronStatus { jobs: CronJob[] }

export function Dashboard() {
  const cron = useQuery({
    queryKey: ['cron-status'],
    queryFn: () => api<CronStatus>('GET', '/v1/admin/cron/status'),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <section className="card">
        <h2 className="font-medium mb-4">Cron jobs (last runs)</h2>
        {cron.isLoading && <p className="text-sm text-slate-500">Loading\u2026</p>}
        {cron.error && <ErrorAlert>{(cron.error as Error).message}</ErrorAlert>}
        {cron.data && (
          cron.data.jobs.length === 0 ? (
            <p className="text-sm text-slate-500">No cron runs recorded yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Job</th>
                  <th className="th">Date key</th>
                  <th className="th">Locked at</th>
                  <th className="th">Completed at</th>
                  <th className="th">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cron.data.jobs.map((j) => (
                  <tr key={`${j.jobName}-${j.dateKey}`}>
                    <td className="td font-mono text-xs">{j.jobName}</td>
                    <td className="td">{j.dateKey}</td>
                    <td className="td text-xs">{j.lockedAt ?? '\u2014'}</td>
                    <td className="td text-xs">{j.completedAt ?? '\u2014'}</td>
                    <td className="td text-rose-700 text-xs">{j.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </section>
    </div>
  );
}
