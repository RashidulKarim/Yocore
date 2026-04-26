# `apps/demo-yopm` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

Tiny reference Express + React app using `@yocore/sdk`. Two purposes:
1. **Documentation by example** for product engineers integrating YoCore.
2. **E2E test target** for Playwright suites.

## Folder layout

```
apps/demo-yopm/src/
├── index.ts                  # express server with sdk.YoCoreServer (API key+secret)
├── routes/
│   ├── public.ts             # signup, signin (proxies to YoCore)
│   ├── protected.ts          # require JWT; show "you are logged in"
│   ├── checkout.ts           # creates checkout session via SDK
│   └── webhooks.ts           # /webhooks/yocore — verifies signature with sdk.verifyWebhook
├── views/                    # minimal HTML or tiny React island
└── config.ts                 # API_KEY, API_SECRET, YOCORE_BASE_URL from env
```

## Rules

1. **No business logic** — this app exists to demonstrate SDK usage. Keep code dead simple, well-commented.
2. **Show patterns**, not features:
   - How to set up the SDK
   - How to handle 401 (refresh)
   - How to verify a webhook
   - How to handle Idempotency-Key
   - How to gracefully fall back if YoCore is down
3. **Comments are documentation.** Use `// 👉` markers to highlight teaching moments.
4. **Don't add features** unless they showcase a real SDK pattern.

## Pitfalls

- **Hardcoded secrets** — never. Always env-driven.
- **Skipped webhook signature verify** — defeats the purpose.
- **Overengineered abstraction** — keep it 100 lines per file max.
