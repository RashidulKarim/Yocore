# ADR-007 — Argon2id in worker pool (off event loop)

**Status:** Accepted

## Context
Argon2id at our parameters (m=19456 KiB, t=2, p=1) takes 80–120ms per hash on production hardware. Doing this on the Node.js main event loop blocks all incoming requests for that duration → catastrophic under any concurrency.

## Decision
Use `piscina` worker thread pool. Default size 4 (configurable via `ARGON2_POOL_SIZE`). All `argon2.hash` and `argon2.verify` calls go through the pool.

## Rationale
- 4 workers × ~10 hashes/sec = 40 hashes/sec sustained throughput.
- Main loop never blocks → P95 latency unaffected by auth load.
- Workers are pre-spawned (no per-call fork cost).

## Consequences
- Test runs with `ARGON2_POOL_SIZE=1` + lower memory params (`NODE_ENV=test`) to stay fast.
- Memory cost: ~80 MB per worker (Argon2 buffer). Total ~320 MB just for pool — acceptable on 2 GB Fargate task.
- Failure of pool worker → re-spawn; no restart of main process needed.
