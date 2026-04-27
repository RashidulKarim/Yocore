import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { beginPkce } from '../lib/pkce.js';
import { ErrorAlert } from '../components/ui.js';
import { useState } from 'react';

/**
 * /authorize — Hosted Auth entry point.
 *
 * Query params (RFC 6749-ish, S256-only):
 *   client_id     — productSlug
 *   redirect_uri  — where to send the user when done (must be in product allowlist)
 *   response_type — must be `code` (we ignore other values for now)
 *
 * If the user is already signed in (sessionStorage has access token), this
 * page will skip straight to /callback to mint a code. Otherwise it stashes
 * a fresh PKCE verifier+state and redirects to /login.
 */
export function AuthorizePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  const productSlug = params.get('client_id') ?? params.get('productSlug') ?? '';
  const redirectUri = params.get('redirect_uri') ?? params.get('redirectUri') ?? '';
  const responseType = params.get('response_type') ?? 'code';

  useEffect(() => {
    if (!productSlug || !redirectUri) {
      setError('Missing required parameters: client_id and redirect_uri.');
      return;
    }
    if (responseType !== 'code') {
      setError('Unsupported response_type. Only `code` is supported.');
      return;
    }
    void (async () => {
      await beginPkce({ productSlug, redirectUri });
      const access = sessionStorage.getItem('yc.access');
      if (access) {
        navigate('/callback', { replace: true });
      } else {
        navigate(`/login?product=${encodeURIComponent(productSlug)}`, { replace: true });
      }
    })();
  }, [productSlug, redirectUri, responseType, navigate]);

  if (error) {
    return (
      <div className="card space-y-4">
        <h1 className="text-2xl font-semibold">Authorize</h1>
        <ErrorAlert>{error}</ErrorAlert>
      </div>
    );
  }
  return (
    <div className="card space-y-4">
      <h1 className="text-2xl font-semibold">Authorize</h1>
      <p className="text-sm text-slate-600">Redirecting\u2026</p>
    </div>
  );
}
