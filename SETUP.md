# YoCore — Complete Setup & Run Guide

> Everything you need to get YoCore running locally from a fresh clone, plus
> troubleshooting notes for the most common issues (including email delivery).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [One-time setup](#one-time-setup)
3. [Environment variables (.env)](#environment-variables-env)
4. [Start the app](#start-the-app)
5. [Local service URLs](#local-service-urls)
6. [Email setup — Mailhog](#email-setup--mailhog)
7. [Billing webhooks — Stripe CLI](#billing-webhooks--stripe-cli)
8. [SSLCommerz sandbox](#sslcommerz-sandbox)
9. [Useful dev commands](#useful-dev-commands)
10. [Reset local state](#reset-local-state)
11. [Running tests](#running-tests)
12. [Production / deployment notes](#production--deployment-notes)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 20.11.0 (`lts/iron`) | `nvm install` from repo root (reads `.nvmrc`) |
| **pnpm** | 9.12.0 | `npm install -g pnpm@9.12.0` |
| **Docker Desktop** | latest | https://www.docker.com/products/docker-desktop |
| **Git** | latest | bundled with OS / https://git-scm.com |
| `mongosh` _(optional)_ | latest | `winget install MongoDB.Shell` (Windows) |
| Stripe CLI _(optional)_ | latest | https://stripe.com/docs/stripe-cli |

---

## One-time setup

```bash
# 1. Clone and enter the repo
git clone <repo-url> yocore
cd yocore

# 2. Switch to the correct Node version
nvm use          # reads .nvmrc → 20.11.0

# 3. Install all workspace dependencies
pnpm install

# 4. Start local infrastructure (MongoDB replica set, Redis, Mailhog, MinIO)
docker compose up -d

# Wait ~10 s for Mongo replica set to initialise, then verify:
docker compose ps
# All four containers should show "healthy" / "Up"

# 5. Copy and configure environment
cp .env.example .env
# Then edit .env — see "Environment variables" section below.

# 6. Build shared packages first (api and others import from @yocore/types)
pnpm turbo run build --filter=@yocore/types

# 7. Seed demo data (creates a demo product + sample billing plans)
pnpm tsx scripts/seed-dev.ts

# 8. Bootstrap the first Super Admin account (run once only)
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email admin@yocore.test \
  --password "AdminP@ssw0rd!"

# 9. Start all dev servers
pnpm dev
```

---

## Environment variables (.env)

Copy `.env.example` to `.env` and fill in the values below.  
All other variables have safe defaults for local dev.

### Required values you MUST set

| Variable | How to generate | Example |
|---|---|---|
| `YOCORE_KMS_KEY` | `openssl rand -hex 32` | `a1b2c3...` (64 hex chars) |
| `BOOTSTRAP_SECRET` | `openssl rand -hex 64` | `d4e5f6...` (128 hex chars) |
| `MONGODB_URI` | docker default | `mongodb://localhost:27017/yocore` |
| `REDIS_URL` | docker default | `redis://localhost:6379` |

### Email configuration (most common issue)

> **⚠ If emails are not being sent after signup, this is almost always the problem.**

For **local development**, email goes through [Mailhog](http://localhost:8025) — no real email is sent, all messages are caught and viewable in the Mailhog web UI.

```dotenv
# ✅ CORRECT for local dev — routes email through Mailhog
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
EMAIL_FROM_DEFAULT=noreply@notifications.yocore.io
```

For **production**, switch to Resend or SES:

```dotenv
# Resend
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM_DEFAULT=noreply@yourapp.com

# — OR — AWS SES
EMAIL_PROVIDER=ses
SES_REGION=us-east-1
EMAIL_FROM_DEFAULT=noreply@yourapp.com
```

> **Why does email break?**  
> When `EMAIL_PROVIDER=resend` (the example default) but `RESEND_API_KEY` is empty,
> the API silently falls back to `consoleDriver` — which only prints to the log and
> never actually delivers the message. The fix is `EMAIL_PROVIDER=smtp` for local dev.

### Full .env reference

```dotenv
# ─── Runtime ──────────────────────────────────────
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug
INSTANCE_ID=local-1

# ─── Database ─────────────────────────────────────
MONGODB_URI=mongodb://localhost:27017/yocore
MONGODB_REPLICA_SET=rs0

# ─── Redis ────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ─── Encryption / KMS ─────────────────────────────
# Generate: openssl rand -hex 32
YOCORE_KMS_KEY=<64-hex-chars>

# ─── JWT ──────────────────────────────────────────
JWT_ISSUER=yocore
JWT_ACCESS_TTL_SECONDS=3600
JWT_REFRESH_TTL_SECONDS=2592000
JWT_REFRESH_TTL_NO_REMEMBER_SECONDS=604800

# ─── Bootstrap ────────────────────────────────────
# Generate: openssl rand -hex 64
BOOTSTRAP_SECRET=<128-hex-chars>

# ─── Super Admin IP allowlist ─────────────────────
SUPER_ADMIN_IP_ALLOWLIST=
SUPER_ADMIN_IP_ALLOWLIST_BYPASS=false

# ─── Email ────────────────────────────────────────
# LOCAL DEV → smtp (Mailhog)   |   PROD → resend or ses
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
# RESEND_API_KEY=              ← fill when EMAIL_PROVIDER=resend
SES_REGION=us-east-1
EMAIL_FROM_DEFAULT=noreply@notifications.yocore.io

# ─── AWS / S3 ─────────────────────────────────────
AWS_REGION=us-east-1
S3_BUCKET_WEBHOOKS=yocore-webhooks
S3_BUCKET_AUDITLOGS=yocore-auditlogs
S3_BUCKET_EXPORTS=yocore-exports
S3_BUCKET_AVATARS=yocore-avatars

# ─── External services ────────────────────────────
SENTRY_DSN=
GRAFANA_OTEL_ENDPOINT=
MAXMIND_LICENSE_KEY=

# ─── Rate limit ───────────────────────────────────
DEFAULT_API_KEY_RATE_LIMIT=1000

# ─── Argon2 worker pool ───────────────────────────
ARGON2_POOL_SIZE=4
```

---

## Start the app

```bash
# Start everything (API + admin-web + auth-web + demo-yopm) in watch mode
pnpm dev

# Start only the API
pnpm dev --filter=@yocore/api

# Start only the admin dashboard
pnpm dev --filter=@yocore/admin-web
```

> Always restart `pnpm dev` after editing `.env`. dotenv is loaded once at process start.

---

## Local service URLs

| Service | URL | Notes |
|---|---|---|
| **API** | http://localhost:3000 | `GET /v1/health` → 200 when ready |
| **Admin Web** | http://localhost:5173 | Super Admin dashboard |
| **Auth Web** | http://localhost:5174 | User login / signup / verify-email |
| **Demo YoPM** | http://localhost:5175 | Example product integration |
| **Mailhog UI** | http://localhost:8025 | View all outgoing emails (local dev) |
| **Mailhog SMTP** | localhost:1025 | SMTP endpoint used by the API |
| **MinIO console** | http://localhost:9001 | S3-compatible storage (`minioadmin` / `minioadmin`) |
| **MongoDB** | mongodb://localhost:27017 | Replica set `rs0` |
| **Redis** | redis://localhost:6379 | |

---

## Email setup — Mailhog

All emails (verification, password reset, MFA codes, etc.) are caught by [Mailhog](http://localhost:8025) in local dev — **no real email is ever sent**.

1. Make sure Docker is running: `docker compose up -d`
2. Ensure `.env` has `EMAIL_PROVIDER=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`
3. Sign up a user at http://localhost:5174/signup?product=demo
4. Open http://localhost:8025 — the verification email will appear there
5. Click the verification link (it points to http://localhost:5174/verify-email?token=...)

Email verification flow summary:
```
User signs up
  → API enqueues email in MongoDB emailQueue collection
  → Email worker (runs every 30 s) picks it up, sends via SMTP to Mailhog
  → Mailhog catches it at localhost:1025
  → You see it at http://localhost:8025
  → Click the link → http://localhost:5174/verify-email?token=<token>
  → auth-web calls API → API marks email verified + issues session
```

---

## Billing webhooks — Stripe CLI

```bash
# Install Stripe CLI (Windows — requires scoop or winget)
winget install Stripe.StripeCLI    # or: scoop install stripe

# Log in
stripe login

# Forward Stripe webhooks to the local API
stripe listen --forward-to localhost:3000/v1/webhooks/stripe

# The CLI prints a webhook signing secret like: whsec_...
# Save that value into the product's gateway config via Admin UI:
# Admin → Products → <product> → Gateways → Stripe → Add credentials
```

---

## SSLCommerz sandbox

1. Register at https://developer.sslcommerz.com/ and get `store_id` + `store_passwd`
2. Use `ngrok http 3000` to expose your local API for IPN callbacks
3. Configure via Admin UI → Products → Gateways → SSLCommerz

---

## Useful dev commands

```bash
pnpm dev                              # all apps in watch mode
pnpm build                            # production build all
pnpm typecheck                        # TypeScript check across all packages
pnpm lint                             # ESLint across all packages
pnpm format                           # Prettier (auto-fix)
pnpm test                             # unit tests (all packages)
pnpm test:integration                 # integration tests (needs Docker running)
pnpm test:e2e                         # Playwright end-to-end tests (needs pnpm dev running)

# Single package
pnpm --filter @yocore/api test
pnpm turbo run build --filter=@yocore/types

# Scripts
pnpm tsx scripts/seed-dev.ts                          # re-seed demo data
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email admin@yocore.test --password "P@ssw0rd!"    # (re-)create super admin
pnpm tsx scripts/bootstrap-jwt-key.ts                 # rotate JWT signing keys
```

---

## Reset local state

```bash
# Drop database + flush Redis, then re-seed
mongosh "mongodb://localhost:27017/yocore?replicaSet=rs0" --eval "db.dropDatabase()"
redis-cli FLUSHALL
pnpm tsx scripts/seed-dev.ts
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email admin@yocore.test --password "AdminP@ssw0rd!"
```

---

## Running tests

```bash
# Unit tests (no Docker required)
pnpm test

# Integration tests — requires Docker running (Mongo replica set + Redis)
docker compose up -d
pnpm test:integration

# E2E tests — requires pnpm dev running in another terminal
pnpm dev &
pnpm test:e2e
```

Coverage gates:
- `apps/api` ≥ 85%
- Security utilities: 100%
- `packages/*` ≥ 90%

---

## Production / deployment notes

| Layer | Service |
|---|---|
| API | AWS ECS Fargate (auto-scaled, min 2 / max 20 tasks) |
| Admin Web | Vercel → admin.yocore.io |
| Auth Web | Vercel → auth.yocore.io |
| MongoDB | Atlas M30 (3-node replica set, multi-AZ) |
| Redis | Upstash Pro (global multi-region active-active) |
| Email | Resend (primary) + AWS SES (fallback) |
| Storage | AWS S3 + KMS |
| Secrets | AWS Secrets Manager (never in env files for prod) |

Secrets for production are pulled from AWS Secrets Manager — **never** hard-code them in `.env` for staging/prod deployments.

---

## Troubleshooting

### Email not received after signup — CRITICAL

This is the most common issue. Follow the checklist in order:

#### 1. Fix the .env configuration

The API reads from **`apps/api/.env`** (not root `.env`). Edit it and verify:

```dotenv
# ✅ CORRECT
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false

# ❌ WRONG — will silently fail
EMAIL_PROVIDER=resend
RESEND_API_KEY=          # ← empty = consoleDriver used, never delivers
```

**Restart the API after editing** — dotenv loads once at process start:
```bash
# Kill existing API process (Ctrl+C from pnpm dev)
pnpm dev --filter=@yocore/api
```

#### 2. Verify Mailhog is running

```bash
docker compose ps
# yocore-mailhog should show "Up"
# yocore-mongo should show "healthy"
```

#### 3. Create a product to allow signups

The database might be empty. Products are global — if none exist, signup returns "Product not found".

**Check if a product exists:**
```bash
cd apps/api
node -e "
const mongoose = require('./node_modules/mongoose');
require('./node_modules/dotenv').config({path:'./.env'});
mongoose.connect(process.env.MONGODB_URI, {replicaSet: process.env.MONGODB_REPLICA_SET}).then(async () => {
  const count = await mongoose.connection.db.collection('products').countDocuments();
  console.log('Products in DB:', count);
  const rows = await mongoose.connection.db.collection('products').find({},{_id:1,slug:1,status:1}).limit(3).toArray();
  console.log(JSON.stringify(rows, null, 2));
  await mongoose.disconnect(); process.exit(0);
}).catch(e=>{console.error(e.message);process.exit(1);});
" 2>&1
cd ..\..\
```

**If no products exist, insert one:**
```bash
cd apps/api
node -e "
const mongoose = require('./node_modules/mongoose');
require('./node_modules/dotenv').config({path:'./.env'});
mongoose.connect(process.env.MONGODB_URI, {replicaSet: process.env.MONGODB_REPLICA_SET}).then(async () => {
  await mongoose.connection.db.collection('products').insertOne({
    _id: 'prod_demo',
    name: 'Demo Product',
    slug: 'demo',
    status: 'ACTIVE',
    apiKey: 'yk_demo_key',
    apiSecretHash: 'demo-secret-hash',
    webhookSecret: 'demo-webhook-secret',
    apiSecretCreatedAt: new Date(),
    domain: null,
    allowedOrigins: ['http://localhost:5174'],
    allowedRedirectUris: ['http://localhost:5174'],
    logoUrl: null,
    description: 'Demo',
    billingScope: 'workspace',
    billingConfig: {
      gatewayRouting: {default:'stripe'},
      gracePeriodDays: 7,
      gracePeriodEmailSchedule: [1,5,7],
      holdPeriodDays: 85,
      holdPeriodWarningDays: [30,60],
      canReactivateDuringHold: true,
      trialDefaultDays: 14,
      trialWarningDays: [3,1]
    },
    webhookUrl: null,
    webhookEvents: [],
    webhookSecretPrevious: {secret:null,deprecatedAt:null,expiresAt:null},
    webhookPayloadVersion: '2026-04-23',
    abandonedAt: null,
    apiKeyLastUsedAt: null,
    settings: null,
    createdBy: null,
    createdAt: new Date(),
    _v: 0
  });
  console.log('Demo product created');
  await mongoose.disconnect(); process.exit(0);
}).catch(e=>{console.error(e.message);process.exit(1);});
" 2>&1
cd ..\..\
```

#### 4. Test signup

```bash
$body = '{"email":"test@example.com","password":"TestP@ssword1!","productSlug":"demo"}'
Invoke-RestMethod -Uri "http://localhost:3000/v1/auth/signup" -Method POST -Body $body -ContentType "application/json"
```

Expected response:
```json
{ "status": "verification_sent" }
```

#### 5. Check Mailhog

Open http://localhost:8025 and look for the email. It should contain a `verifyToken` link.

#### 6. Check MongoDB email queue

If Mailhog is empty, check the email worker status:

```bash
cd apps/api
node -e "
const mongoose = require('./node_modules/mongoose');
require('./node_modules/dotenv').config({path:'./.env'});
mongoose.connect(process.env.MONGODB_URI, {replicaSet: process.env.MONGODB_REPLICA_SET}).then(async () => {
  const rows = await mongoose.connection.db.collection('emailQueue').find({}).sort({_id:-1}).limit(5).toArray();
  console.log(JSON.stringify(rows.map(r=>({id:r._id,to:r.toAddress,status:r.status,provider:r.provider,attempts:r.attemptCount,template:r.templateId})), null, 2));
  await mongoose.disconnect(); process.exit(0);
}).catch(e=>{console.error(e.message);process.exit(1);});
" 2>&1
cd ..\..\
```

Look for:
- `status: 'SENT'` → email was delivered to Mailhog (check http://localhost:8025)
- `status: 'PENDING'` → waiting for next 30s worker tick (restart API to trigger immediately)
- `status: 'DEAD'` → email failed after retries (check `attempts` array for error)

#### Common email issues & solutions

| Symptom | Cause | Fix |
|---|---|---|
| Mailhog at :8025 is empty, but emailQueue has `SENT` rows | `EMAIL_PROVIDER` is not `smtp` — consoleDriver used | Edit `apps/api/.env`, set `EMAIL_PROVIDER=smtp`, restart API |
| Signup returns "Product not found" | No products exist in DB | Insert a demo product (see step 3 above) |
| Mailhog shows email but no token in body | Template rendering not implemented | Check API logs — template IDs like `auth.email_verify` are placeholders (see email-worker.service.ts) |

---

### MongoDB: dual instance issue — API vs mongosh connect to different DBs

**Problem:** You might have both a local standalone MongoDB and Docker's MongoDB replica set running. `mongosh` might connect to the standalone, while the API connects to Docker's replica set. This causes:
- Data inserted via `mongosh` is invisible to the API
- Products inserted with `mongosh` disappear when API tries to find them
- Email queues are empty in the API but you see data in `mongosh`

**How to identify which MongoDB the API is using:**

```bash
cd apps/api
node -e "
const mongoose = require('./node_modules/mongoose');
require('./node_modules/dotenv').config({path:'./.env'});
const uri = process.env.MONGODB_URI;
const rs = process.env.MONGODB_REPLICA_SET;
console.log('API config:');
console.log('  URI:', uri);
console.log('  Replica Set:', rs);
mongoose.connect(uri, rs ? {replicaSet: rs, serverSelectionTimeoutMS: 5000} : {serverSelectionTimeoutMS: 5000}).then(async () => {
  const admin = await mongoose.connection.db.admin();
  const status = await admin.serverStatus();
  console.log('Connected to version:', status.version);
  console.log('Replica set:', status.replicaSet || 'NONE (standalone)');
  const count = await mongoose.connection.db.collection('products').countDocuments();
  console.log('Products visible to API:', count);
  await mongoose.disconnect(); process.exit(0);
}).catch(e=>{console.error('Connect failed:', e.message); process.exit(1);});
" 2>&1
cd ..\..\
```

**Solution:**

1. **Only use Docker's MongoDB for local dev.** Stop any local MongoDB:
   ```bash
   # macOS
   brew services stop mongodb-community
   
   # Windows (if installed)
   net stop MongoDB
   ```

2. **Always use the API's config when inserting test data:**
   ```bash
   # ❌ Wrong — goes to standalone MongoDB
   mongosh "mongodb://localhost:27017/yocore" --eval "db.products.insertOne({...})"
   
   # ✅ Correct — goes to Docker's MongoDB (replica set)
   cd apps/api && node << 'EOF'
   const mongoose = require('./node_modules/mongoose');
   require('./node_modules/dotenv').config({path:'./.env'});
   mongoose.connect(process.env.MONGODB_URI, {replicaSet: process.env.MONGODB_REPLICA_SET}).then(async () => {
     await mongoose.connection.db.collection('products').insertOne({...});
     await mongoose.disconnect(); process.exit(0);
   });
   EOF
   cd ..\..\
   ```

3. **Verify Docker MongoDB is replica set enabled:**
   ```bash
   docker compose up -d mongo
   docker exec yocore-mongo mongosh --eval "rs.status()"
   # Should return replica set info with "myState" (not an error)
   ```

---

### MongoDB: session / transaction errors

Transactions require a replica set. The `docker-compose.yml` healthcheck initiates `rs0` automatically. If it breaks after a container restart:

```bash
docker compose restart mongo
# Wait ~15 s for healthcheck to pass
docker compose ps
# yocore-mongo should show "healthy"
```

If still broken:
```bash
docker exec yocore-mongo mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]})"
```

---

### `EADDRINUSE :3000`

A previous API process is still running. Kill it:

```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

---

### TypeScript errors after fresh install

`@yocore/types` must be compiled before other packages can import it:

```bash
pnpm turbo run build --filter=@yocore/types
```

---

### argon2 install fails (Apple Silicon macOS)

```bash
xcode-select --install
pnpm install
```

---

### API env validation error at startup

If you see `[env] invalid configuration` in the console, the Zod schema rejected your `.env`. Check:
- `YOCORE_KMS_KEY` must be exactly 64 hex characters (`openssl rand -hex 32`)
- `BOOTSTRAP_SECRET` must be at least 32 characters
- `MONGODB_URI` and `REDIS_URL` must be set

---

### Idempotency-Key required error (400)

All mutating billing endpoints require an `Idempotency-Key` header. Use any UUID:

```bash
curl -X POST http://localhost:3000/v1/... \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{...}'
```
