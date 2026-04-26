# YoCore — Local Development Setup

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 20.11.0 (use `.nvmrc`) | `nvm install` from repo root |
| pnpm | ≥9.0 | `npm install -g pnpm@9.12.0` |
| Docker Desktop | latest | https://docker.com |
| MongoDB Shell (`mongosh`) | latest | `brew install mongosh` (macOS) |

## First-time setup

```bash
# 1. Clone & install
git clone <repo-url> yocore && cd yocore
nvm use
pnpm install

# 2. Bring up local infra (Mongo replica set, Redis, Mailhog, MinIO)
docker compose up -d

# Wait ~10s for Mongo replica set to initiate, then verify:
docker compose ps
mongosh "mongodb://localhost:27017/?replicaSet=rs0" --eval "rs.status().ok"

# 3. Copy env file
cp .env.example .env
# Generate a real KMS key for local dev:
openssl rand -hex 32  # paste into YOCORE_KMS_KEY in .env
openssl rand -hex 64  # paste into BOOTSTRAP_SECRET in .env

# 4. Initial build (compiles packages/types so others can import)
pnpm turbo run build --filter=@yocore/types

# 5. Seed dev data (creates demo product + sample plans)
pnpm tsx scripts/seed-dev.ts

# 6. Bootstrap super admin
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email admin@yocore.test \
  --password 'AdminP@ssw0rd!'

# 7. Run dev servers
pnpm dev
```

After `pnpm dev`:
- API: http://localhost:3000 (`/v1/health` should return 200)
- Admin Web: http://localhost:5173
- Auth Web: http://localhost:5174
- Demo YoPM: http://localhost:5175
- Mailhog UI: http://localhost:8025
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

## Common commands

```bash
pnpm dev                      # all apps in watch mode
pnpm dev --filter=api         # just API
pnpm typecheck                # all packages
pnpm lint                     # all packages
pnpm test                     # all unit tests
pnpm test:integration         # integration tests (needs Mongo + Redis up)
pnpm test:e2e                 # Playwright (needs all apps running)
pnpm build                    # production build for all
pnpm format                   # write Prettier
pnpm --filter @yocore/types build   # single package
```

## Stripe sandbox linking

```bash
# Install Stripe CLI: https://stripe.com/docs/stripe-cli
stripe login

# Forward Stripe webhooks to local API
stripe listen --forward-to localhost:3000/v1/webhooks/stripe

# Copy the printed `whsec_...` and configure it via Admin UI
# (Screen 9 → Gateways → Stripe → Add credentials)
```

## SSLCommerz sandbox

- Register at https://developer.sslcommerz.com/
- Get `store_id` + `store_passwd` for sandbox
- Configure via Admin UI (Screen 9)
- Use `ngrok http 3000` to expose local API for IPN callbacks

## Resetting local state

```bash
# Wipe Mongo + Redis (keeps Docker volumes; just empties DBs)
mongosh "mongodb://localhost:27017/yocore?replicaSet=rs0" --eval "db.dropDatabase()"
redis-cli FLUSHALL

# Re-seed
pnpm tsx scripts/seed-dev.ts
```

## Common pitfalls

1. **Mongo replica set required.** Sessions + transactions need replica set. The `docker-compose.yml` healthcheck initiates it; if Mongo container restarts cleanly but sessions break, re-run the healthcheck command manually.
2. **`pnpm install` fails on macOS Apple Silicon for argon2.** Run `xcode-select --install` first; argon2 needs native compiler.
3. **Forgot to build `@yocore/types`.** Other packages import from it as workspace dep. Run `pnpm turbo run build --filter=@yocore/types` once after fresh install.
4. **`.env` not loaded.** API loads via `dotenv` but only at process start; restart `pnpm dev` after editing.
5. **Argon2 super slow in tests.** Tests use `ARGON2_POOL_SIZE=1` + lower memory params via `NODE_ENV=test`. Production uses full params (~80ms/hash).
6. **Idempotency-Key required on POST/PATCH.** Local dev still enforces it. Use any UUID for testing.

## Per-package developer docs

- API: `apps/api/.github/copilot-instructions.md`
- Admin Web: `apps/admin-web/.github/copilot-instructions.md`
- SDK: `packages/sdk/.github/copilot-instructions.md`
