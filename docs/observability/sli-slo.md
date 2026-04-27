# YoCore — SLI / SLO Definitions

> **Status:** v1.1 baseline. Re-evaluate after 90 days of production data.
>
> **Owner:** Platform team. PagerDuty rotation: `yocore-platform-oncall`.

This document defines the **Service Level Indicators** (what we measure) and
the **Service Level Objectives** (the target we hold ourselves to). Burn-rate
alerts are derived from each SLO using the Google SRE multi-window
multi-burn-rate methodology.

All metrics are exported by `apps/api` from `/metrics` (Prometheus format).
Dashboards live in [`grafana-dashboards/`](./grafana-dashboards/).

---

## 1. Availability — Public API

| Field | Value |
|---|---|
| **SLI** | `1 - (sum(rate(yocore_http_request_duration_seconds_count{status=~"5.."}[5m])) / sum(rate(yocore_http_request_duration_seconds_count[5m])))` |
| **SLO** | **99.9 %** of HTTP requests return non-5xx over a rolling 30-day window. |
| **Error budget** | 43 minutes / 30 days |
| **Fast burn alert** | 14.4× burn rate over 1h (page) |
| **Slow burn alert** | 1× burn rate over 6h (ticket) |

---

## 2. Sign-in latency

| Field | Value |
|---|---|
| **SLI** | `histogram_quantile(0.95, sum(rate(yocore_signin_duration_seconds_bucket[5m])) by (le))` |
| **SLO** | **p95 ≤ 350 ms** for sign-in over a rolling 7-day window. |
| **Notes** | Argon2id verification (~80 ms) dominates. Below 350 ms is achievable when the worker pool is hot. |

---

## 3. Outbound webhook delivery freshness

| Field | Value |
|---|---|
| **SLI** | Median age of `webhookDeliveries` rows in `PENDING` status. Computed by `yocore_webhook_delivery_duration_seconds` and a separate gauge for queue depth (TODO). |
| **SLO** | **99 % of webhook deliveries** succeed (status=`delivered`) within **60 s of enqueue** over a rolling 7-day window. |
| **DEAD letter SLO** | < 0.1 % of deliveries reach `DEAD` over 30 days. |
| **Alert** | Page if `increase(yocore_webhook_delivery_total{status="dead"}[1h]) > 5`. |

---

## 4. Cron job freshness

| Field | Value |
|---|---|
| **SLI** | `time() - yocore_cron_last_run_timestamp_seconds` |
| **SLO** | Each registered cron runs successfully within `2× schedule_interval`. |
| **Alert (per job)** | Page if last successful run is older than the job's `lockTtlMs * 2`. |

---

## 5. External provider availability (circuit breakers)

| Field | Value |
|---|---|
| **SLI** | `yocore_circuit_state{name=~"stripe.*\|sslcommerz.*"}` |
| **SLO** | Each provider's breaker spends ≤ 1 % of a rolling 24h window in OPEN (state=2). |
| **Alert** | Page when `yocore_circuit_state == 2` for more than 5 minutes. |

---

## 6. Database health

| Field | Value |
|---|---|
| **SLI** | Connection saturation, p95 query latency (collected by OpenTelemetry mongoose instrumentation). |
| **SLO** | p95 query duration ≤ 50 ms; pool utilization < 75 %. |

---

## Burn-rate alert recipes

```promql
# 1h fast-burn for the API availability SLO (1% budget burn in 1h ≈ 14.4× rate).
(
  sum(rate(yocore_http_request_duration_seconds_count{status=~"5.."}[1h]))
  /
  sum(rate(yocore_http_request_duration_seconds_count[1h]))
) > (14.4 * 0.001)
```

```promql
# 6h slow-burn for the same SLO.
(
  sum(rate(yocore_http_request_duration_seconds_count{status=~"5.."}[6h]))
  /
  sum(rate(yocore_http_request_duration_seconds_count[6h]))
) > (6 * 0.001)
```

---

## Dashboards

* `grafana-dashboards/api-overview.json` — overall API health
* `grafana-dashboards/webhooks-crons.json` — webhook + cron deep-dive

Import via Grafana UI → Dashboards → Import → Upload JSON.

---

## Runbook links

* SLO violation (sign-in p95 high) → check Argon2 pool saturation + Mongo p95.
* Webhook DEAD spike → see [stripe-webhook-replay.md](./runbooks/stripe-webhook-replay.md).
* Circuit breaker OPEN → see provider runbook in [`runbooks/`](../runbooks/).
