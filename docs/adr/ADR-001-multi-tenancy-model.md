# ADR-001 — Multi-tenancy via single MongoDB with `productId` filter

**Status:** Accepted (April 2026)

## Context
YoCore serves multiple Yo products (YoPM, YoSuite, future). Options for tenant isolation:
1. Database-per-product
2. Schema-per-product within shared DB
3. Single DB, row-level filter on `productId`

## Decision
Single MongoDB cluster, single database, every collection (except `users`, `bundles`, `superAdminConfig`, `jwtSigningKeys`) carries `productId`. API-key middleware injects `req.productId` and every query is filtered by it (enforced at repo layer + Mongoose pre-find hook).

## Rationale
- Operational simplicity: one cluster to back up, monitor, scale.
- Cross-product Super Admin queries are O(1) (no fan-out).
- MongoDB has no native RLS; we accept application-level enforcement and test for it.
- Migration path: if compliance ever requires per-product isolation, we can split into separate Atlas projects without schema changes.

## Consequences
- Every repo function MUST take `productId` (linted).
- Integration tests explicitly probe cross-product leakage.
- A bug forgetting the filter could leak across products → P0 risk; mitigated via `BaseRepo` enforcing it.
