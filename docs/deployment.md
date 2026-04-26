# YoCore — Deployment & Infrastructure

## Topology

```
                ┌─────────────────────────┐
                │   Cloudflare (DNS+CDN)  │
                └──────────┬──────────────┘
                           │ HTTPS
                ┌──────────▼─────────────┐
                │   AWS ALB (multi-AZ)   │
                └──────────┬─────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
       ┌────▼────┐    ┌────▼────┐   ┌────▼────┐
       │ ECS Fargate │  ECS │  ECS │
       │  apps/api   │  api │  api │   ← auto-scaled (min 2, max 20)
       └────┬────────┘ └─────┘ └─────┘
            │
   ┌────────┼────────────┬─────────────┬──────────────┐
   │        │            │             │              │
┌──▼───┐ ┌──▼─────┐ ┌────▼─────┐ ┌─────▼─────┐ ┌──────▼────┐
│Mongo │ │Upstash │ │   AWS    │ │  Resend   │ │  Stripe   │
│Atlas │ │ Redis  │ │   S3+KMS │ │   SES     │ │SSLCommerz │
│ M30  │ │ multi  │ │+SecretsM │ │           │ │           │
└──────┘ └────────┘ └──────────┘ └───────────┘ └───────────┘

Frontends → Vercel:
  - apps/admin-web  → admin.yocore.io
  - apps/auth-web   → auth.yocore.io
```

## Environments

| Env | API | Admin | Auth | Mongo | Redis | Stripe | Email |
|---|---|---|---|---|---|---|---|
| local | docker | localhost:5173 | localhost:5174 | docker | docker | test | mailhog |
| staging | ECS staging cluster | Vercel preview | Vercel preview | Atlas M10 | Upstash staging | test | Resend staging domain |
| production | ECS prod cluster | Vercel prod | Vercel prod | Atlas M30 (replica set 3-node multi-AZ) | Upstash prod (multi-region) | live | Resend prod domain + SES fallback |

## ECS Fargate task def (sketch)

```json
{
  "family": "yocore-api",
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [{
    "name": "api",
    "image": "ECR_URI/yocore-api:GIT_SHA",
    "essential": true,
    "portMappings": [{ "containerPort": 3000 }],
    "secrets": [
      { "name": "MONGODB_URI", "valueFrom": "arn:aws:secretsmanager:...:yocore/prod/mongodb" },
      { "name": "REDIS_URL",   "valueFrom": "arn:aws:secretsmanager:...:yocore/prod/redis" },
      { "name": "YOCORE_KMS_KEY", "valueFrom": "arn:aws:secretsmanager:...:yocore/prod/kms-dek" },
      { "name": "BOOTSTRAP_SECRET", "valueFrom": "arn:aws:secretsmanager:...:yocore/prod/bootstrap" }
    ],
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "LOG_LEVEL", "value": "info" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/ecs/yocore-api", "awslogs-region": "us-east-1" }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:3000/v1/health || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
    }
  }]
}
```

## MongoDB Atlas

| Env | Tier | Storage | Backup | Notes |
|---|---|---|---|---|
| dev | M0 (free) | 512 MB | none | shared |
| staging | M10 | 10 GB | daily snapshots, 7d | dedicated |
| production | M30 | 40 GB | continuous PITR + daily snapshots, 30d | 3-node replica set, multi-AZ within region |

- Read preference: `primary` for writes; `secondary` for analytics aggregations (Super Admin dashboard).
- Connection pool: 10–100 (Mongoose default auto-tunes).
- Network: VPC peering with ECS VPC; no public access.

## Upstash Redis

| Env | Tier | Region |
|---|---|---|
| dev | docker | local |
| staging | Free | us-east-1 |
| production | Pro (10k cmd/s) | global multi-region (active-active) |

- TLS required.
- Eviction: `allkeys-lru`.
- Persistence: AOF.

## S3 buckets

| Bucket | Region | Lifecycle | Encryption | Public |
|---|---|---|---|---|
| `yocore-webhooks-prod` | us-east-1 | expire @90d | AES-256 SSE | no |
| `yocore-auditlogs-prod` | us-east-1 (replicate to eu-west-1) | Glacier @90d, expire @7y | AES-256 + Object Lock (compliance mode) | no |
| `yocore-exports-prod` | us-east-1 (replicate to eu-west-1) | expire @30d | AES-256 SSE | pre-signed URLs only (7d max) |
| `yocore-avatars-prod` | us-east-1 | none | AES-256 SSE | CloudFront-fronted public read |

## AWS Secrets Manager structure

```
yocore/prod/
  mongodb           → connection URI
  redis             → connection URL
  kms-dek           → 32-byte hex (AES-256-GCM data encryption key)
  bootstrap         → 64-byte hex (one-time)
  jwt-keys          → KMS-encrypted private keys (or rely on jwtSigningKeys collection)
  resend            → API key
  ses               → IAM role (no key — uses task role)
  stripe-platform   → optional platform-level key for product onboarding
  sentry-dsn        → DSN
  grafana-otel      → OTLP endpoint + token
```

Rotation: AWS Secrets Manager auto-rotation Lambda every 30d for `kms-dek` (envelope re-encryption).

## CI/CD pipeline

1. **PR opened** → GitHub Actions: lint, typecheck, unit, integration tests (uses GitHub-provided Mongo + Redis services).
2. **Merge to `main`** → Build Docker image → push to ECR `yocore-api:GIT_SHA` and `yocore-api:main`.
3. **Auto-deploy staging** → ECS service update (rolling, min healthy 100%).
4. **Smoke test** against staging URL.
5. **Manual approval** (GitHub environment protection) → deploy production with same image SHA.
6. **Canary**: ALB weighted routing 10% → 50% → 100% over 15 min.
7. **Rollback**: ECS service rollback to previous task def.

## Vercel for frontends

- Auto-deploy preview per PR for `apps/admin-web` and `apps/auth-web`.
- Production deploy on `main` merge.
- Env vars set per environment in Vercel dashboard.

## Cron job execution

Crons run inside the same ECS task as the API (Agenda framework). To prevent duplicate execution across multiple instances, every cron uses `cronLocks` Mongo collection (unique index on `{jobName, dateKey}`) + Redis `SET NX` fast path.

## Disaster recovery

- **RTO**: < 1 hour
- **RPO**: < 5 minutes (Mongo continuous PITR)
- See [runbooks/disaster-recovery.md](./runbooks/disaster-recovery.md).

## Cost estimate (production, baseline)

| Component | Monthly |
|---|---|
| ECS Fargate (2 tasks × 1 vCPU × 2 GB) | ~$60 |
| Mongo Atlas M30 | ~$200 |
| Upstash Redis Pro | ~$80 |
| ALB | ~$25 |
| S3 + CloudFront | ~$30 |
| Secrets Manager | ~$5 |
| Vercel Pro (2 projects) | $40 |
| **Total** | **~$440** |

Excludes: data egress, Resend, Stripe fees, Sentry, Grafana Cloud.
