import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from './components/AppLayout.js';
import { LoginPage } from './pages/Login.js';
import { SetupMfaPage } from './pages/SetupMfa.js';
import { Dashboard } from './pages/Dashboard.js';
import { ProductsList } from './pages/ProductsList.js';
import { ProductDetail } from './pages/ProductDetail.js';
import { PlansList } from './pages/PlansList.js';
import { Subscriptions } from './pages/Subscriptions.js';
import { WebhookDeliveries } from './pages/WebhookDeliveries.js';
import { TosPage } from './pages/Tos.js';
import { SuperAdminSettings } from './pages/SuperAdminSettings.js';
import { ProductUsersPage } from './pages/ProductUsers.js';
import { UserDetailPage } from './pages/UserDetail.js';
import { ProductWorkspacesPage } from './pages/ProductWorkspaces.js';
import { WorkspaceDetailPage } from './pages/WorkspaceDetail.js';
import { AllUsersSearchPage } from './pages/AllUsersSearch.js';
import { BundlesListPage } from './pages/BundlesList.js';
import { BundleDetailPage } from './pages/BundleDetail.js';
import { AnnouncementsPage } from './pages/Announcements.js';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/setup-mfa" element={<SetupMfaPage />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/products" element={<ProductsList />} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/products/:productId/users" element={<ProductUsersPage />} />
        <Route path="/products/:productId/users/:userId" element={<UserDetailPage />} />
        <Route path="/products/:productId/workspaces" element={<ProductWorkspacesPage />} />
        <Route
          path="/products/:productId/workspaces/:workspaceId"
          element={<WorkspaceDetailPage />}
        />
        <Route path="/users" element={<AllUsersSearchPage />} />
        <Route path="/plans" element={<PlansList />} />
        <Route path="/bundles" element={<BundlesListPage />} />
        <Route path="/bundles/:id" element={<BundleDetailPage />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/announcements" element={<AnnouncementsPage />} />
        <Route path="/webhooks" element={<WebhookDeliveries />} />
        <Route path="/tos" element={<TosPage />} />
        <Route path="/settings" element={<SuperAdminSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
