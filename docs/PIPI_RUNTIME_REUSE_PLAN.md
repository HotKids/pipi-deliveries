# Pipi runtime reuse plan

This is an implementation plan only. It does not change Pipi runtime code.

## Target behavior

Pipi should reuse the iOS lifecycle, cache, authority, and scheduling model
without copying screen-specific implementation. The shared contract is:

- provider-aware `ORDERED`/`PICKED` start detection;
- per-provider incremental caches and whole-package selection;
- Meizu Picker first for manual Home/status presentation;
- detail may use a fuller downstream package without rewriting Picker's
  presentation package;
- no visible row before the pending query has a timed track, with 24-hour
  pending expiry;
- all active unsigned shipments remain in background polling;
- provider cooldown/backoff with jitter, durable leases, bounded batches,
  delta-aware commits, and network-based freshness;
- unchanged notification aggregation.

## Pipi manual chain

1. Query Meizu Picker first and merge it with Pipi's existing Meizu cache.
2. If the accumulated Picker package contains `ORDERED` or `PICKED`, stop the
   current chain.
3. Otherwise run the currently eligible primary providers and add Pipi's
   existing OPPO adapter as an independent provider package. OPPO must not be
   merged into Picker or another provider's tracks.
4. Apply Pipi's existing carrier-support rules to OPPO. Adding OPPO does not
   relax source-specific exclusions such as the Moto ban for ShunFeng and
   JingDong source shipments.
5. Invoke KDNiao only if all accumulated pre-KDNiao packages still lack start
   evidence.
6. Keep Picker as Home/status authority when usable. Select the most complete
   eligible whole package for detail.

The adapter result must carry an explicit provider id (`oppo`), normalized
status evidence, provider event time, query success time, route metadata, and a
stable identity fingerprint so it can use the same cache and retry machinery.

## Source-specific rules

### Cainiao

- Pipi Cainiao shipments always use the trusted Cainiao H5 detail surface.
- They do not query or select Meizu, Moto, OPPO, Kuaidi100, or KDNiao local
  timelines.
- A stale manual sidecar must not suppress Cainiao H5.

### ShunFeng

- Meizu Picker is first and owns Home/status when usable.
- Moto is excluded.
- Eligible downstream detail providers run only when accumulated Picker history
  lacks `ORDERED` and `PICKED`.
- The account-source package remains the final coarse fallback and is never
  concatenated with a manual package.

### JingDong

- Evaluate the account-source incremental package first.
- If it contains `ORDERED` or `PICKED`, do not start the manual chain.
- Otherwise allow manual takeover without Moto. Preserve the existing isolated
  order-to-waybill projection and never let an order identity replace a known
  carrier waybill.

## Suggested implementation boundaries

- `TimelineLifecyclePolicy`: provider-aware start/terminal classification and
  equal-time regression protection.
- `TimelineCacheStore`: provider-keyed incremental merge, 156-track compaction,
  and atomic shipment mutation.
- `TimelineAuthorityPolicy`: separate Home/status and detail selection.
- `ManualQueryCoordinator`: Picker-first sequencing, OPPO participation, and
  the accumulated start gate.
- `SourceRoutingPolicy`: Cainiao H5-only, ShunFeng/JingDong Moto exclusions,
  and account-source precedence.
- `RefreshRuntimeState`: provider schedules, classified backoff, jitter,
  network-success timestamps, and cross-runtime leases.
- `PendingManualStore`: hidden pending records, promotion on timed evidence, and
  24-hour expiry.

## Migration and validation

- Read existing manual caches as provider-specific sidecars; do not rewrite
  them into a synthetic merged history.
- Ignore stale manual authority for Cainiao when resolving its H5 route.
- Preserve Pipi's current default account interface unless a separate product
  decision changes it.
- Add contract tests for Picker one-track presentation, accumulated start
  short-circuiting, OPPO package isolation, ShunFeng/JingDong Moto exclusion,
  Cainiao H5-only routing, pending promotion/expiry, equal-time regression,
  lease contention, and no-op refresh feedback.
- Roll out behind diagnostic provider labels first, then verify Home, detail,
  widget, notification, and background behavior against the same shipment
  fixtures before enabling automatic migration.
