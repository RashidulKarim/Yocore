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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/setup-mfa" element={<SetupMfaPage />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/products" element={<ProductsList />} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/plans" element={<PlansList />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/webhooks" element={<WebhookDeliveries />} />
        <Route path="/tos" element={<TosPage />} />
        <Route path="/settings" element={<SuperAdminSettings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
