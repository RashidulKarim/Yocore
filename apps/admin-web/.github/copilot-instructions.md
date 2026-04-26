# `apps/admin-web` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

Super Admin SPA. React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + React Hook Form + React Router v6. **Internal tool**, not customer-facing.

## Folder layout

```
apps/admin-web/src/
├── main.tsx                  # entry; mount QueryClient + RouterProvider
├── app/
│   ├── router.tsx            # createBrowserRouter; route protection wrappers
│   └── query-client.ts
├── lib/
│   ├── api.ts                # fetch wrapper with auth + correlationId
│   ├── session.ts            # JWT in-memory + refresh logic
│   └── format.ts
├── pages/
│   ├── login/                # Screen: super-admin login + MFA challenge
│   ├── dashboard/            # Screen 1
│   ├── products/             # Screen 2 + nested screens 3–9
│   ├── users/                # Screen 10
│   ├── bundles/              # Screen 11 + 11a
│   ├── announcements/        # Screen 12
│   └── settings/             # Screen 13
├── components/
│   ├── ui/                   # shadcn/ui generated components (DO NOT edit by hand)
│   └── shared/               # cross-screen widgets (data tables, status badges, etc.)
├── hooks/                    # custom hooks (useSession, useEntitlement, etc.)
└── styles/                   # tailwind config + globals.css
```

## Rules

1. **Auth gate first.** Every route except `/login` is wrapped in `<RequireSuperAdmin>` which checks JWT + MFA-completed flag.
2. **All API calls via TanStack Query.** No raw fetch in components. Use the `api()` wrapper from `lib/api.ts` which auto-attaches `Authorization`, `X-Correlation-Id`, and `X-Idempotency-Key` (UUID per mutation).
3. **Forms use RHF + Zod.** Schemas come from `@yocore/types/schemas`. Use `zodResolver`.
4. **shadcn/ui only.** Do not introduce other UI libraries (no MUI, no AntD). Add new shadcn primitives via the CLI (`pnpm dlx shadcn-ui@latest add <component>`).
5. **No business logic in components.** Move to hooks (`hooks/`) or services (`lib/`).
6. **Errors:** parse `{ error: code, message, correlationId }` from API. Show toast with `message` + copy-button for `correlationId` (for support).
7. **Polling for non-blocking aggregations.** Dashboard widgets that compute slow data poll every 30s; show "as of <timestamp>" UI.
8. **Optimistic updates only when safe** (e.g., toggle on/off where backend confirms quickly). For payments / status changes — pessimistic.
9. **Permission checks in UI are UX-only.** Backend re-validates everything. Use `usePermission(action)` hook to hide forbidden buttons but never trust the result.
10. **Idempotency-Key on every POST/PATCH** — generate via `crypto.randomUUID()` and reuse if the user retries.
11. **Format dates with user's TZ** — read from session.preferences.timezone.

## Common pitfalls

- **Forgot `<RequireSuperAdmin>` on a new route** — auth bypass. The route guard MUST wrap.
- **Used `useEffect` to fetch** — use TanStack Query.
- **Blocked the UI on a slow aggregation** — make it polling-based.
- **Hardcoded API base URL** — use `import.meta.env.VITE_API_URL` or proxy.
- **Stored JWT in localStorage** — NO. In-memory only; refresh via httpOnly cookie or via `/auth/refresh` call.
- **Did not invalidate queries after mutation** — use `queryClient.invalidateQueries({ queryKey: [...] })` in `onSuccess`.

## Test rules

- Component tests via `@testing-library/react` + `vitest` (jsdom).
- Mock TanStack Query with `MemoryRouter` + a test `QueryClient` per test (no shared state).
- Coverage target ≥70%; remaining covered by Playwright E2E (in `apps/admin-web/e2e/`).
