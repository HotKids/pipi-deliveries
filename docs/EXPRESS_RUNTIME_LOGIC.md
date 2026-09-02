# Express runtime contract

This document is the owning runtime contract for iOS Scripting and Android
Lite. Business source and physical carrier are separate identities. A source
policy is selected from `sourceProvider`; carrier recognition may refine query
parameters but must not change source ownership.

## Lifecycle evidence

- `ORDERED` and `PICKED` are timeline-start evidence. They include structured
  provider states and normalized descriptions such as placed, waiting for
  pickup, picked up, or collected.
- A provider-aware parser must be used for numeric states. The same numeric
  value from an account feed and Meizu Picker is not assumed to mean the same
  lifecycle state.
- The current query run stops its remaining downstream providers as soon as the
  accumulated pre-fallback caches contain `ORDERED` or `PICKED`. The gate is not
  based only on the latest response.
- The start gate does not retire a shipment. Every active, unsigned shipment
  remains eligible for later background polling until it becomes terminal.
- Same-provider incremental responses merge with that provider's cache. Tracks
  from different providers remain separate whole packages.
- Durable histories are bounded to 156 nodes while retaining the earliest
  order/pickup evidence and terminal evidence required by lifecycle decisions.
- An equal-time update cannot regress a stronger lifecycle state to a weaker
  one.

## Presentation and detail ownership

- Meizu Picker is the first manual source and owns Home, widget, notification,
  and status presentation when it returned a usable package, even if it
  returned only one timed track.
- A more complete downstream package may own detail presentation without
  rewriting Picker's Home/status package.
- If Picker returns no usable package, the best successful downstream package
  may own both presentation and detail.
- A network result is committed only when it materially changes durable state.
  A cache-only reopen or an equivalent provider response does not produce a
  success toast or a second state revision.
- Cached tracks remain visible when a refresh fails. Cache preservation is not
  surfaced as a failure toast.

## Manual submit and pending queries

- Submit and keyboard return display `查询中` before network work begins.
- The first query asks Meizu Picker and opens its result immediately when it has
  a timed track. The detail flow may continue only when the accumulated Picker
  cache lacks `ORDERED` and `PICKED`.
- A phone-tail validation message is shown only when the selected carrier
  actually requires the four-digit tail and no usable result was returned.
- Untimed or empty submissions are not inserted into the visible shipment
  list. They enter the pending queue, are retried in background, are promoted
  only after a timed track appears, and expire after 24 hours.
- A successful manual query is persisted without dismissing the Scripting
  surface. Row actions and their confirmations likewise stay inside the app.

## iOS Scripting provider policy

### Ordinary manual shipments

1. Query Meizu Picker and merge its incremental cache.
2. If accumulated Picker history has no start evidence, run the eligible
   primary detail sources.
3. Invoke KDNiao only when every accumulated pre-KDNiao cache still lacks start
   evidence.
4. Picker remains Home/status authority; a fuller primary or KDNiao package may
   own detail.

### ShunFeng source

- Meizu Picker is first and owns Home/status when usable.
- Moto never participates.
- Kuaidi100 H5 may supply the fuller detail package when Picker lacks start
  evidence; KDNiao remains the final network fallback.
- The Xiaomi account package is the last coarse presentation fallback. It is
  not merged with Picker, Kuaidi100, or KDNiao tracks.

### JingDong source

- The Xiaomi account incremental package is evaluated first. If its accumulated
  timeline contains `ORDERED` or `PICKED`, it owns Home/status/detail and the
  manual chain does not start.
- Otherwise the manual chain may take over. Moto never participates.
- An unresolved shopping order may use the existing isolated JD H5 projection
  only to obtain the real carrier waybill and presentation identity. The order
  number must never replace a known carrier waybill.
- A carrier-signed terminal state cannot be downgraded by an order-level
  completion summary.

### Cainiao source

- iOS retains its source-specific account/H5/local policy. Each package remains
  independent and the accumulated start gate controls any later fallback.
- Cainiao H5 credentials and route references remain opaque durable state.

## Android Lite provider policy

- Interface 6 remains the default account source.
- Meizu Picker is queried first for eligible manual and source-takeover rows.
  Moto runs only for an eligible ordinary manual row whose accumulated Picker
  cache lacks start evidence.
- Android Lite has no KDNiao fallback. When no accumulated local package has
  start evidence and Picker supplied a trusted Kuaidi100 route, the detail
  surface opens that Kuaidi100 webpage.
- ShunFeng source uses Picker first, never Moto, and keeps its account package as
  the final coarse cache.
- JingDong source evaluates the account incremental package first. Without
  start evidence it enters the manual path without Moto; the unresolved-order
  identity projection remains a separate concern.
- Cainiao source never uses local timeline selection, manual sidecars, or the
  Kuaidi100 fallback chain. Any stale manual sidecar is ignored. A valid trusted
  Cainiao route always opens Cainiao H5 as the detail surface.

## Refresh scheduling and persistence

- Foreground and background runs use the same provider policy. Background work
  is host-safe and does not open a visible WebView.
- Active unsigned shipments, including manual rows and eligible source-takeover
  rows, are enrolled in background polling. Current-run start evidence only
  saves downstream calls for that run.
- iOS provider schedules are independent. Success cooldowns, classified failure
  backoff, and stable jitter prevent synchronized retries without blocking
  unrelated providers. Its durable cross-runtime leases coordinate the app,
  widget, intent, and background runner, and manual work runs in bounded waves.
- Android uses transactional owner claims plus finite WorkManager retries so
  foreground and background refreshes cannot concurrently own the same manual
  timeline.
- Widget freshness is based on the last successful network refresh, not a local
  cache write.
- Notification aggregation is intentionally unchanged.

## Failure boundaries

- Empty, timed-out, rejected, cancelled, or late responses cannot erase a
  successful provider cache.
- Required durable writes complete before best-effort UI feedback, widget
  reloads, or notifications.
- A route is opened only after scheme, host, credential availability, and
  source ownership pass the platform-specific trust checks.
- Deleting or manually completing a shipment is an idempotent state mutation;
  it does not terminate the Scripting process or navigate to the host app.
