import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError, setAdminToken } from '../lib/api.js';
import { Input, Label, Button, ErrorAlert } from '../components/ui.js';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().optional(),
});
type Inputs = z.infer<typeof schema>;

interface SigninResponse {
  status: 'mfa_required' | 'signed_in';
  mfaChallengeId?: string;
  tokens?: { accessToken: string; refreshToken: string };
}

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Inputs>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Inputs) {
    setError(null);
    try {
      const res = await api<SigninResponse>('POST', '/v1/auth/signin', {
        body: {
          email: values.email,
          password: values.password,
          ...(challengeId ? { mfaChallengeId: challengeId, mfaCode: values.mfaCode } : {}),
        },
      });
      if (res.status === 'mfa_required' && res.mfaChallengeId) {
        setChallengeId(res.mfaChallengeId);
        return;
      }
      if (res.status === 'signed_in' && res.tokens) {
        setAdminToken(res.tokens.accessToken);
        navigate('/', { replace: true });
        return;
      }
      setError('Unexpected response');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network error');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card w-full max-w-md space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">YoCore Admin</h1>
          <p className="mt-1 text-sm text-slate-600">Sign in with your Super Admin credentials.</p>
        </div>
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
            {errors.email && <p className="text-xs text-rose-600 mt-1">{errors.email.message}</p>}
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
          </div>
          {challengeId && (
            <div>
              <Label htmlFor="mfaCode">MFA code</Label>
              <Input id="mfaCode" inputMode="numeric" autoComplete="one-time-code" {...register('mfaCode')} />
            </div>
          )}
          <Button type="submit" loading={isSubmitting}>{challengeId ? 'Verify' : 'Sign in'}</Button>
        </form>
      </div>
    </div>
  );
}
