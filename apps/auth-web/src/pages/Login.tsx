import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api.js';
import { Input, Label, Button, FieldError, ErrorAlert } from '../components/ui.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

type LoginInputs = z.infer<typeof loginSchema>;

interface SigninResponse {
  status: 'mfa_required' | 'signed_in';
  mfaChallengeId?: string;
  tokens?: { accessToken: string; refreshToken: string };
}

export function LoginPage() {
  const [params] = useSearchParams();
  const productSlug = params.get('product') ?? params.get('productSlug') ?? '';
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInputs>({ resolver: zodResolver(loginSchema) });

  useEffect(() => {
    if (!productSlug) {
      // Allow direct visits in dev — but PKCE flow always sets product.
    }
  }, [productSlug]);

  async function onSubmit(values: LoginInputs) {
    setServerError(null);
    try {
      const out = await api<SigninResponse>('POST', '/v1/auth/signin', {
        body: { ...values, productSlug: productSlug || undefined },
      });
      if (out.status === 'mfa_required' && out.mfaChallengeId) {
        sessionStorage.setItem('yc.mfa.challenge', out.mfaChallengeId);
        sessionStorage.setItem('yc.mfa.email', values.email);
        sessionStorage.setItem('yc.mfa.password', values.password);
        if (productSlug) sessionStorage.setItem('yc.mfa.product', productSlug);
        navigate('/mfa', { replace: true });
        return;
      }
      if (out.status === 'signed_in' && out.tokens) {
        // Stash tokens & continue to /callback which finishes any pending PKCE flow.
        sessionStorage.setItem('yc.access', out.tokens.accessToken);
        sessionStorage.setItem('yc.refresh', out.tokens.refreshToken);
        navigate('/callback', { replace: true });
        return;
      }
      setServerError('Unexpected response from server');
    } catch (err) {
      if (err instanceof ApiError) setServerError(err.message);
      else setServerError('Network error');
    }
  }

  return (
    <div className="card space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        {productSlug && (
          <p className="mt-1 text-sm text-slate-600">to <span className="font-medium">{productSlug}</span></p>
        )}
      </div>

      {serverError && <ErrorAlert>{serverError}</ErrorAlert>}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
          <FieldError>{errors.email?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
          <FieldError>{errors.password?.message}</FieldError>
        </div>
        <Button type="submit" loading={isSubmitting}>Sign in</Button>
      </form>

      <div className="flex items-center justify-between text-sm">
        <Link to={`/signup${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline">
          Create account
        </Link>
        <Link to={`/forgot${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline">
          Forgot password?
        </Link>
      </div>
    </div>
  );
}
