import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { Button, ErrorAlert, Input, Label } from '../components/ui.js';

interface EnrolStartResponse { enrolmentId: string; otpauthUri: string; secret: string }

export function SetupMfaPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'start' | 'verify' | 'done'>('start');
  const [enrolmentId, setEnrolmentId] = useState('');
  const [secret, setSecret] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function startEnrol() {
    setError(null);
    setLoading(true);
    try {
      const res = await api<EnrolStartResponse>('POST', '/v1/auth/mfa/enrol');
      setEnrolmentId(res.enrolmentId);
      setSecret(res.secret);
      setOtpauthUri(res.otpauthUri);
      setStep('verify');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to start MFA setup');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ enrolled: boolean; recoveryCodes: string[] }>('POST', '/v1/auth/mfa/enrol/verify', {
        body: { enrolmentId, code },
      });
      if (res.enrolled) {
        setRecoveryCodes(res.recoveryCodes);
        setStep('done');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Invalid code — try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Set up two-factor authentication</h1>
          <p className="mt-1 text-sm text-slate-600">MFA is mandatory for Super Admin accounts.</p>
        </div>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        {step === 'start' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              You will need an authenticator app such as Google Authenticator, Authy, or 1Password.
            </p>
            <Button loading={loading} onClick={startEnrol}>Begin setup</Button>
          </div>
        )}

        {step === 'verify' && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">1. Scan this QR code in your authenticator app</p>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(otpauthUri)}`}
                alt="TOTP QR code"
                className="border rounded-lg"
              />
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Or enter the key manually:</p>
              <code className="block font-mono text-xs bg-slate-100 rounded px-3 py-2 break-all select-all">{secret}</code>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">2. Enter the 6-digit code from your app</p>
              <Label htmlFor="mfa-code">Verification code</Label>
              <Input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </div>
            <Button loading={loading} onClick={verifyCode} disabled={code.length !== 6}>Verify &amp; enable MFA</Button>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3">
              <p className="text-sm font-medium text-green-800">MFA enabled successfully!</p>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700 mb-2">Save your recovery codes</p>
              <p className="text-xs text-slate-500 mb-3">
                Store these in a secure location. Each code can only be used once. If you lose access to your authenticator, these are your only way back in.
              </p>
              <div className="bg-slate-900 rounded-lg p-4 font-mono text-xs text-green-400 space-y-1">
                {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
              </div>
            </div>
            <Button onClick={() => navigate('/', { replace: true })}>Continue to dashboard</Button>
          </div>
        )}
      </div>
    </div>
  );
}
