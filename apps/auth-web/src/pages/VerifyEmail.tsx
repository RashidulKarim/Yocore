import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { ErrorAlert, InfoAlert } from '../components/ui.js';

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const productSlug = params.get('product') ?? '';
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    if (!token) {
      setState('error');
      setMessage('Verification link is invalid.');
      return;
    }
    api<{ status: string; alreadyVerified?: boolean; tokens?: { accessToken: string; refreshToken: string } }>(
      'GET',
      `/v1/auth/verify-email?token=${encodeURIComponent(token)}`,
    )
      .then((out) => {
        if (out.tokens) {
          sessionStorage.setItem('yc.access', out.tokens.accessToken);
          sessionStorage.setItem('yc.refresh', out.tokens.refreshToken);
        }
        setState('ok');
        setMessage(
          out.alreadyVerified
            ? 'This email was already verified.'
            : 'Your email is verified \u2014 you can now sign in.',
        );
      })
      .catch((err: unknown) => {
        setState('error');
        setMessage(err instanceof ApiError ? err.message : 'Verification failed.');
      });
  }, [token]);

  return (
    <div className="card space-y-4">
      <h1 className="text-2xl font-semibold">Email verification</h1>
      {state === 'loading' && <p className="text-sm text-slate-600">Verifying\u2026</p>}
      {state === 'ok' && <InfoAlert>{message}</InfoAlert>}
      {state === 'error' && <ErrorAlert>{message}</ErrorAlert>}
      <Link to={`/login${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline text-sm">
        Continue to sign in
      </Link>
    </div>
  );
}
