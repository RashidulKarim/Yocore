# ADR-008 — Distributed cron locks via Mongo unique index

**Status:** Accepted

## Context
API runs as multiple ECS task replicas (≥2 always). Cron jobs (grace tick, trial tick, deletion finalize, etc.) must run exactly once per scheduled tick across the fleet.

## Decision
Each cron job acquires a lock by inserting into `cronLocks` with unique index `{jobName, dateKey}`. First instance succeeds; rest get E11000 duplicate key → silently exit. Redis `SET lock:cron:<jobName>:<dateKey> 1 NX EX 3600` is the fast-path pre-check (avoids the Mongo round-trip in steady state).

`dateKey` granularity:
- Hourly cron → `YYYY-MM-DD-HH`
- Daily cron → `YYYY-MM-DD`

## Rationale
- Mongo unique index = source of truth for idempotency (Redis can be down).
- TTL on `cronLocks.lockedAt` (24h) auto-cleans old rows.
- No external dependency (Zookeeper, etcd) to operate.

## Consequences
- Crons must always include `dateKey` derived deterministically from current time.
- Long-running crons must update `cronLocks.completedAt` so monitoring can detect stuck runs.
- Failure cron sets `cronLocks.error`; retry policy decided per job.
