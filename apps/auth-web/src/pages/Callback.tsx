import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { readPkceContext, pkceChallenge, clearPkce } from '../lib/pkce.js';
import { ErrorAlert, InfoAlert } from '../components/ui.js';

/**
 * /callback — completes a PKCE flow.
 *
 *  1. Read access token from sessionStorage (set by Login or MfaChallenge).
 *  2. Read PKCE verifier+state+productSlug+redirectUri from sessionStorage.
 *  3. POST /v1/auth/pkce/issue with codeChallenge derived from verifier.
 *  4. Redirect browser to `<redirectUri>?code=&state=`.
 *
 * If no PKCE flow is pending, show a generic "signed in" confirmation.
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const access = sessionStorage.getItem('yc.access');
    const pkce = readPkceContext();

    if (!access) {
      navigate('/login', { replace: true });
      return;
    }
    if (!pkce) {
      setInfo('You are signed in.');
      return;
    }

    void (async () => {
      try {
        const codeChallenge = await pkceChallenge(pkce.verifier);
        const out = await api<{ code: string; state: string }>('POST', '/v1/auth/pkce/issue', {
          bearer: access,
          body: {
            productSlug: pkce.productSlug,
            redirectUri: pkce.redirectUri,
            state: pkce.state,
            codeChallenge,
            codeChallengeMethod: 'S256',
          },
        });
        clearPkce();
        const url = new URL(pkce.redirectUri);
        url.searchParams.set('code', out.code);
        url.searchParams.set('state', out.state);
        window.location.replace(url.toString());
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'PKCE issue failed.');
      }
    })();
  }, [navigate]);

  return (
    <div className="card space-y-4">
      <h1 className="text-2xl font-semibold">Finishing sign-in\u2026</h1>
      {info && <InfoAlert>{info}</InfoAlert>}
      {error && <ErrorAlert>{error}</ErrorAlert>}
    </div>
  );
}
