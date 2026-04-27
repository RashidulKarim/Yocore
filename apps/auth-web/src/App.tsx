import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/Login.js';
import { SignupPage } from './pages/Signup.js';
import { ForgotPasswordPage } from './pages/ForgotPassword.js';
import { ResetPasswordPage } from './pages/ResetPassword.js';
import { MfaChallengePage } from './pages/MfaChallenge.js';
import { VerifyEmailPage } from './pages/VerifyEmail.js';
import { AuthorizePage } from './pages/Authorize.js';
import { CallbackPage } from './pages/Callback.js';

export default function App() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4 py-12">
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot" element={<ForgotPasswordPage />} />
        <Route path="/reset" element={<ResetPasswordPage />} />
        <Route path="/mfa" element={<MfaChallengePage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/authorize" element={<AuthorizePage />} />
        <Route path="/callback" element={<CallbackPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </div>
  );
}
