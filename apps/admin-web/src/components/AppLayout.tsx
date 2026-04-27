import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getAdminToken, setAdminToken } from '../lib/api.js';
import { LayoutDashboard, Box, FileText, Cog, ScrollText, Webhook, Receipt, Package, Users, Megaphone } from 'lucide-react';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/products', label: 'Products', icon: Box },
  { to: '/users', label: 'All users (search)', icon: Users },
  { to: '/plans', label: 'Plans', icon: Receipt },
  { to: '/bundles', label: 'Bundles', icon: Package },
  { to: '/subscriptions', label: 'Subscriptions', icon: FileText },
  { to: '/announcements', label: 'Announcements', icon: Megaphone },
  { to: '/webhooks', label: 'Webhook deliveries', icon: Webhook },
  { to: '/tos', label: 'ToS / Privacy', icon: ScrollText },
  { to: '/settings', label: 'Super Admin', icon: Cog },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const mfaStatus = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => api<{ enrolled: boolean }>('GET', '/v1/auth/mfa/status'),
    enabled: !!getAdminToken(),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!getAdminToken()) {
      navigate('/login', { replace: true });
      return;
    }
    if (mfaStatus.data && !mfaStatus.data.enrolled && location.pathname !== '/setup-mfa') {
      navigate('/setup-mfa', { replace: true });
    }
  }, [navigate, location.pathname, mfaStatus.data]);

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white px-4 py-6">
        <div className="mb-6 px-2 text-lg font-semibold tracking-tight">YoCore Admin</div>
        <nav className="space-y-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                  isActive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-slate-700 hover:bg-slate-100'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => {
            setAdminToken(null);
            navigate('/login', { replace: true });
          }}
          className="mt-8 w-full text-left text-xs text-slate-500 hover:text-slate-800"
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
