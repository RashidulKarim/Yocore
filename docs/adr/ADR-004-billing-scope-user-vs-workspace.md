# ADR-004 — Billing scope: per-user vs per-workspace, configured per-product

**Status:** Accepted

## Context
Some products are sold to individuals (solo productivity tools); others to teams (B2B). Should subscription always be workspace-scoped? Or per-user?

## Decision
Each product declares `billingScope: "user" | "workspace"` at registration. Subscriptions table has `subjectUserId` XOR `subjectWorkspaceId` (Mongo `$jsonSchema` enforces exactly one). API-layer guard ensures match with product's billingScope.

## Rationale
- A single product won't switch scope mid-life (operationally messy).
- Different products legitimately need different models (YoPM = workspace; future YoNotes = user).
- Seat-based plans only meaningful when `billingScope=workspace`.

## Consequences
- All billing endpoints receive `subjectId` and resolve scope from product config.
- Bundle components must share billingScope (validated pre-publish).
- Reporting queries filter on subject type as well as productId.
