# YoPM Demo — End-to-End Feature Tester

A full-feature demo product wired to YoCore. Use it to exercise every
end-user / product-side feature that `apps/api` and `apps/admin-web`
expose, without writing a custom client. Auth-web is **not** required —
the demo does direct product-scoped sign-in via `POST /v1/auth/signin`.

## What's covered

| Area | Routes / pages |
|---|---|
| Public catalog | `/plans` (calls `GET /v1/products/:slug/plans`) |
| Auth | `/signup`, `/verify-email`, `/signin` (incl. MFA second leg), `/forgot-password`, `/reset-password`, `/email-change-confirm`, `/signout` |
| Account | `/account` (overview), `/account/sessions`, `/account/mfa` (enrol/verify/regen), `/account/email-prefs`, `/account/email-change`, `/account/data-exports`, `/account/deletion`, `/account/finalize-onboarding` |
| Workspaces | `/workspaces` (list/create/switch), `/workspaces/:id` (rename, members CRUD, invites, transfer ownership, soft-delete + restore) |
| Invitations | `/accept-invite?token=…` (preview + accept-new for cross-product) |
| Billing | `/billing` (invoices, tax profile, change-plan preview/apply, seats, pause/resume, gateway migrate, validate coupon), `/billing/checkout`, `/billing/trial/start` |
| Bundles | `/bundles` (subscribe by id + cancel) |
| Webhooks | `POST /webhooks` (HMAC-verified receiver) + `GET /webhooks/log` (in-memory ring of last 50 events) |

## 0 — Pre-requisites

- Mongo + Redis running (`docker compose up -d`)
- `apps/api` running on `:4000` (`pnpm --filter @yocore/api dev`)
- `apps/admin-web` running on `:5173` (`pnpm --filter @yocore/admin-web dev`)

## 1 — Bootstrap a super-admin & sign in to admin-web

```bash
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email superadmin@example.com \
  --password 'YourStrongPassword!1'
```

Open <http://localhost:5173>, sign in, complete MFA enrolment.

## 2 — Create the YoPM product in admin-web

In admin-web → **Products** → **Create product**:

- name: `YoPM Demo`
- slug: `yopm-demo` (must match `YOCORE_PRODUCT_SLUG` below)
- billingScope: `workspace` (the demo creates workspaces)
- webhookUrl: `http://localhost:5175/webhooks`

After creation, copy the **API key** and **API secret** that appear once.
Then in **Webhook secret** click **rotate** and copy that too.

Optionally add a Stripe / SSLCommerz gateway under the product so paid
plans + checkout work end-to-end. Skip this if you only want to test free
plans, trials, signup, workspaces, MFA, GDPR.

## 3 — Publish at least one plan

In admin-web → product → **Plans** → **Create plan** → publish. A free
plan ($0) works for browsing + subscribe; a paid plan needs Stripe.
Optionally set `trialDays > 0` so the demo can call `/v1/billing/trial/start`.

## 4 — Configure demo-yopm

Create `apps/demo-yopm/.env` (or export the vars in your shell):

```
YOCORE_BASE_URL=http://localhost:4000
YOCORE_PRODUCT_SLUG=yopm-demo
YOCORE_PRODUCT_API_KEY=yc_live_pk_xxxxxxxxxxxxxxxx
YOCORE_PRODUCT_API_SECRET=base64url-32-bytes
YOCORE_WEBHOOK_SECRET=hex-32-bytes
DEMO_YOPM_PORT=5175
```

Note: `tsx` does NOT auto-load `.env`. Either use `dotenv-cli` or export
manually:

```bash
set -a; source apps/demo-yopm/.env; set +a
pnpm --filter @yocore/demo-yopm dev
```

## 5 — Walk the flows

1. Open <http://localhost:5175> → **Browse plans**.
2. Click a plan → **Sign up to subscribe** → fill the form.
3. Check the API logs (or Mailhog at <http://localhost:8025> if wired) for
   the verification email link, click it. You'll land on `/account`.
4. From `/account` → **Finalize onboarding** to create the first workspace.
5. From `/workspaces/:id`:
   - Invite a teammate → check Mailhog for the invite link →
     `/accept-invite?token=…` accepts it.
   - Change a member's role; remove a member; transfer ownership.
   - Rename, soft-delete (30-day grace) and restore.
   - Switch active workspace via the **Switch** button.
6. From `/account/mfa` → **Start enrol** → add the secret to your authenticator
   → submit the 6-digit code → save the 10 recovery codes shown ONCE.
   Sign out, sign in again — you'll be challenged for an MFA code.
7. From `/billing`:
   - Update tax profile.
   - Click **Subscribe** on a paid plan to start a Stripe checkout (test
     mode; use `4242 4242 4242 4242`).
   - Or click **Start trial** on a plan with `trialDays > 0`.
   - After the subscription is active, exercise **Change plan** /
     **Seats** / **Pause / Resume** / **Migrate gateway**.
8. From `/account/data-exports` → request a GDPR export (account or
   product scope).
9. From `/account/deletion` → request deletion (re-auth required) and
   then cancel it before the grace window expires.
10. Webhooks: trigger any subscription action and visit
    <http://localhost:5175/webhooks/log> to see the verified event payload.
    Bad signatures are rejected with 401.

## 6 — Tearing down

`Ctrl-C` in each terminal. Demo session state lives only in memory, so
restarting the demo signs everyone out.

## Troubleshooting

- **"401 AUTH_INVALID_TOKEN" everywhere** — the API restarted and your
  session JWT was minted under an old keyring. Sign out and back in.
- **Plans page empty** — make sure the plan is `ACTIVE` and visible
  (not archived).
- **Webhook 401** — check `YOCORE_WEBHOOK_SECRET` matches the secret
  shown in admin-web after rotation. There's a 24h grace where the
  previous secret also works.
- **Checkout returns 404 BILLING_GATEWAY_UNAVAILABLE** — the product has
  no gateway configured for the plan's currency. Add one in admin-web.
- **Bundle checkout 422** — bundles are super-admin curated. Use
  admin-web → **Bundles** to create one, then paste its id into
  `/bundles`.
