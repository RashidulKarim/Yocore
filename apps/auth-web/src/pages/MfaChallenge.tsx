import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api.js';
import { Input, Label, Button, FieldError, ErrorAlert, InfoAlert } from '../components/ui.js';

const schema = z.object({
  code: z.string().min(6).max(10),
});
type Inputs = z.infer<typeof schema>;

interface SigninResponse {
  status: 'mfa_required' | 'signed_in';
  mfaChallengeId?: string;
  tokens?: { accessToken: string; refreshToken: string };
}

export function MfaChallengePage() {
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const [challenge] = useState({
    challengeId: sessionStorage.getItem('yc.mfa.challenge') ?? '',
    email: sessionStorage.getItem('yc.mfa.email') ?? '',
    password: sessionStorage.getItem('yc.mfa.password') ?? '',
    productSlug: sessionStorage.getItem('yc.mfa.product') ?? '',
  });

  useEffect(() => {
    if (!challenge.challengeId || !challenge.email) {
      navigate('/login', { replace: true });
    }
  }, [challenge, navigate]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Inputs>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Inputs) {
    setServerError(null);
    try {
      const out = await api<SigninResponse>('POST', '/v1/auth/signin', {
        body: {
          email: challenge.email,
          password: challenge.password,
          mfaChallengeId: challenge.challengeId,
          mfaCode: values.code,
          productSlug: challenge.productSlug || undefined,
        },
      });
      if (out.status === 'signed_in' && out.tokens) {
        sessionStorage.removeItem('yc.mfa.challenge');
        sessionStorage.removeItem('yc.mfa.email');
        sessionStorage.removeItem('yc.mfa.password');
        sessionStorage.setItem('yc.access', out.tokens.accessToken);
        sessionStorage.setItem('yc.refresh', out.tokens.refreshToken);
        navigate('/callback', { replace: true });
        return;
      }
      setServerError('Verification failed.');
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Network error');
    }
  }

  return (
    <div className="card space-y-6">
      <h1 className="text-2xl font-semibold">Two-factor verification</h1>
      <InfoAlert>Enter the 6-digit code from your authenticator app.</InfoAlert>
      {serverError && <ErrorAlert>{serverError}</ErrorAlert>}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="code">Authentication code</Label>
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus {...register('code')} />
          <FieldError>{errors.code?.message}</FieldError>
        </div>
        <Button type="submit" loading={isSubmitting}>Verify</Button>
      </form>
    </div>
  );
}
