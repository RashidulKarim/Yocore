# `@yocore/sdk`

Public TypeScript SDK for the YoCore platform. Two flavors plus shared utilities.

## Install

```bash
pnpm add @yocore/sdk
```

Requires Node 18+ (uses native `fetch` and Web Crypto).

## Server-side usage (`YoCoreServer`)

For product backends and platform admin scripts. Authenticates with API key + secret (HTTP Basic).

```ts
import { YoCoreServer, retry } from '@yocore/sdk';

const sdk = new YoCoreServer({
  apiKey: process.env.YOCORE_KEY!,
  apiSecret: process.env.YOCORE_SECRET!,
  baseUrl: 'https://api.yocore.app',
});

await retry(() => sdk.listPlans('demo-product'));

await sdk.changePlan(
  'prd_xxx',
  'sub_yyy',
  { newPlanId: 'pln_zzz', quantity: 5 },
  crypto.randomUUID(), // Idempotency-Key (mandatory on mutating billing endpoints)
);
```

## Browser usage (`YoCoreClient`)

For end-user web apps. Drives the PKCE auth flow + authenticated calls.

```ts
import { YoCoreClient } from '@yocore/sdk';

const c = new YoCoreClient({
  apiKey: 'pk_live_...',
  baseUrl: 'https://api.yocore.app',
});

// 1. Generate PKCE pair, persist verifier in sessionStorage.
const verifier = await YoCoreClient.createPkceVerifier();
const challenge = await YoCoreClient.pkceChallenge(verifier);
sessionStorage.setItem('pkce_v', verifier);

// 2. Redirect user to /authorize.
location.href = c.buildAuthorizeUrl({
  productSlug: 'demo',
  redirectUri: 'https://app.example.com/auth/callback',
  state: crypto.randomUUID(),
  codeChallenge: challenge,
});

// 3. On callback, exchange code for tokens.
const tokens = await c.exchangeCode({
  code: new URLSearchParams(location.search).get('code')!,
  verifier: sessionStorage.getItem('pkce_v')!,
  redirectUri: 'https://app.example.com/auth/callback',
});
c.setAccessToken(tokens.accessToken);

const me = await c.me();
```

## Webhook signature verification

```ts
import express from 'express';
import { verifyWebhookSignature, WebhookSignatureError } from '@yocore/sdk';

app.post(
  '/yocore-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      verifyWebhookSignature(
        req.body,                                     // Buffer (raw body)
        req.header('x-yocore-signature'),
        process.env.YOCORE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      if (err instanceof WebhookSignatureError) return res.sendStatus(400);
      throw err;
    }
    const evt = JSON.parse(req.body.toString('utf8'));
    // ... handle event
    res.sendStatus(200);
  },
);
```

The verifier is constant-time and rejects timestamps outside a 5-minute window
(replay protection).

## Retry helper

`retry(fn, opts)` — exponential full-jitter backoff with `Retry-After` awareness.
By default retries `429` and `5xx`; never retries `4xx`.

```ts
await retry(() => sdk.listPlans('demo'), { maxAttempts: 5, baseMs: 250 });
```

## Errors

Every non-2xx API response is thrown as `YoCoreApiError`:

```ts
import { isYoCoreApiError } from '@yocore/sdk';

try {
  await sdk.listPlans('demo');
} catch (err) {
  if (isYoCoreApiError(err)) {
    console.error(err.code, err.status, err.correlationId);
  }
}
```
