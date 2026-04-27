import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Button, Empty, ErrorAlert, Input } from '../components/ui.js';

interface UserRow {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  productCount: number;
}

export function AllUsersSearchPage() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');

  const search = useQuery({
    queryKey: ['admin', 'user-search', submitted],
    queryFn: () =>
      api<{ users: UserRow[] }>('GET', '/v1/admin/users/search', {
        query: { q: submitted, limit: 50 },
      }),
    enabled: submitted.length >= 2,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">All users (global search)</h1>

      <form
        className="card flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <div className="flex-1">
          <label className="label">Email contains</label>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="alice@example.com"
            autoFocus
          />
        </div>
        <Button type="submit">Search</Button>
      </form>

      <div className="card overflow-hidden p-0">
        {!submitted && <p className="p-4 text-sm text-slate-500">Enter an email substring above.</p>}
        {search.error && <div className="p-4"><ErrorAlert>{(search.error as Error).message}</ErrorAlert></div>}
        {search.isLoading && submitted && <p className="p-4 text-sm text-slate-500">Searching…</p>}
        {search.data && (search.data.users.length === 0 ? <Empty>No users match.</Empty> : (
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Email</th>
                <th className="th">Verified</th>
                <th className="th">Products</th>
                <th className="th">Global ID</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {search.data.users.map((u) => (
                <tr key={u.id}>
                  <td className="td">{u.email}</td>
                  <td className="td text-xs">{u.emailVerified ? '✓' : '—'}</td>
                  <td className="td text-xs">{u.productCount}</td>
                  <td className="td font-mono text-xs">{u.id}</td>
                  <td className="td text-xs">{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
