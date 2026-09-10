# Express runtime contract

This document describes the iOS Scripting and Android Lite runtime under
`docs/EXPRESS_THREE_CLIENT_PARITY_20260901.md`, including its approved
2026-09-09 interface partitions. Business source and physical carrier are separate identities. A source
policy is selected from `sourceProvider`; carrier recognition may refine query
parameters but must not change source ownership.

## Lifecycle evidence

- `ORDERED` and `PICKED` are timeline-start evidence. Text evidence uses the
  exact shared vocabulary in `AGENTS.md` §9 (2026-09-07); waiting for collection
  (`待揽收` / `等待揽收`) alone is not start evidence.
- A provider-aware parser must be used for numeric states. The same numeric
  value from an account feed and Meizu query is not assumed to mean the same
  lifecycle state.
- The current query run stops its remaining downstream providers as soon as the
  accumulated pre-fallback caches contain `ORDERED` or `PICKED`. The gate is not
  based only on the latest response.
- The start gate does not retire a shipment. Every active, unsigned shipment
  remains eligible for later background polling until it becomes terminal.
- Same-provider incremental responses merge with that provider's cache. Tracks
  from different providers remain separate whole packages.
- Same-source histories retain all valid nodes without a fixed node cap.
  Existing same-package deduplication and the shared start vocabulary remain
  authoritative.
- An equal-time update cannot regress a stronger lifecycle state to a weaker
  one.

## Presentation and detail ownership

- For manual shipments, Meizu query is the first source and owns Home, widget, notification,
  and status presentation when it returned a usable package, even if it
  returned only one timed track.
- ShunFeng Home/list and detail on all three clients use the same existing manual
  package selection for headline, event time and history. A complete K100 package
  can replace an older partial Meizu display. Existing completeness, freshness,
  coverage, provider-order and sticky rules apply; no provider nodes are mixed.
  Structured status/time ownership and terminal protection remain unchanged.
- If Meizu returns no usable package, the best successful downstream package
  may own both presentation and detail.
- Automatic feed status, activity and history remain owned by the feed;
  ShunFeng retains its explicit manual-package display exception. A same-owner account
  query or eligible manual package may supplement missing fields only, without
  merging provider caches or replacing valid feed fields.
- A network result is committed only when it materially changes durable state.
  A cache-only reopen or an equivalent provider response does not produce a
  success toast or a second state revision.
- Cached tracks remain visible when a refresh fails. Cache preservation is not
  surfaced as a failure toast.

## Manual submit and pending queries

- Submit and keyboard return display `查询中` before network work begins.
- The first query asks Meizu query and shows a transient preview when it has
  a timed track. The owner and all successful provider sidecars are committed
  atomically only when the round finishes. The detail flow may continue only
  when the accumulated Meizu cache lacks `ORDERED` and `PICKED`.
- A phone-tail validation message is shown only when the selected carrier
  actually requires the four-digit tail and no usable result was returned.
- Untimed or empty submissions are not inserted into the visible shipment
  list. They enter the pending queue, are retried in background, are promoted
  only after a timed track appears, and expire after 24 hours.
- A successful manual query is persisted without dismissing the Scripting
  surface. Row actions and their confirmations likewise stay inside the app.

## iOS Scripting provider policy

### Ordinary manual shipments

1. Query Meizu query and merge its incremental cache.
2. If accumulated Meizu history has no start evidence, run the eligible
   primary detail sources.
3. Invoke KDNiao only when every accumulated pre-KDNiao cache still lacks start
   evidence.
4. Meizu remains Home/status authority; a fuller primary or KDNiao package may
   own detail.

### ShunFeng source

- Meizu query is first and owns Home/status when usable.
- Moto never participates.
- Kuaidi100 H5 may supply the fuller detail package when Meizu lacks start
  evidence; KDNiao remains the final network fallback.
- The Xiaomi account package is the last coarse presentation fallback. It is
  not merged with Meizu, Kuaidi100, or KDNiao tracks.

### JingDong source

- Feed and account-query histories remain independent packages. Automatic
  PICKED evidence or a complete automatic H5 package closes ordinary history
  supplementation; missing structured status has its own supplementation gate.
- Xiaomi text identity is used first. JD H5 opens only while the carrier waybill
  is unresolved and the current account-detail query returned no timed tracks.
  The same hidden page load may supply identity and one isolated H5 timeline
  package. It never supplies structured shipment status from prose.
- Eligible manual supplementation uses Meizu, then the permitted final KDNiao
  fallback. Moto and K100 H5 do not participate for JingDong business sources.
- The order number must never replace a known carrier waybill.
- A carrier-signed terminal state cannot be downgraded by an order-level
  completion summary.

### Cainiao source

- iOS retains its source-specific account/H5/local policy. Each package remains
  independent and the accumulated start gate controls any later fallback.
- Cainiao H5 credentials and route references remain opaque durable state.

## Android Lite provider policy

- Interface 6 remains the default account source.
- Automatic owner qualification compares canonical binding slots; account-query
  and account-list aliases do not prevent a valid source packet from establishing its owner.
- If an Interface 5 Home row has no usable activity, its same-waybill account
  query may supply the latest timed activity and display time. If the feed's
  displayed status is UNKNOWN, the query may independently supply its explicit
  status enum and its own event time. A missing event time remains zero; neither
  headline time nor H5 prose can manufacture delivery evidence. Query status
  evidence survives persistence, while older caches retain history without
  retroactively gaining structured evidence. Existing Home fields, routes and
  feed nodes remain owned by their original package.
- Existing manual-add, detail and eligible list stages query Meizu Online
  (`queryByMailNoOnline`) through gateway wire mode `refresh`. There is no LastDetail
  request or additional query stage. Existing list eligibility remains unchanged.
  Provider/cache identifiers and new writes use `v6_query`. Legacy Meizu slot aliases
  are normalized on read and merged through the existing same-provider reducer before
  writing the canonical slot; stored history and completeness declarations are not
  deleted or relabeled as new endpoint responses. Sticky selections are normalized
  when loaded. A scalar latest event remains partial.
- Meizu is queried first for eligible manual and source-takeover rows.
  Moto runs only for an eligible ordinary manual row whose accumulated Meizu
  cache lacks start evidence.
- Android Lite has no KDNiao fallback. The already-eligible K100 H5 stage opens
  `https://m.kuaidi100.com/app/query/?nu=` with the encoded normalized actual
  waybill. It does not require a Meizu-returned route, including after Meizu
  returns no history or fails. Its existing stage eligibility, package checks,
  and capture cooldown remain unchanged.
  The fixed page's `#main` Vue instance supplies `lists`/`alllists` to the existing
  bounded extraction, alongside the older supported page roots.
- K100 phone verification uses only this parcel's saved phone suffix or its explicit
  manual input, and only when the suffix is four digits. Submission requires HTTPS,
  exactly `m.kuaidi100.com/app/query/`, one `nu` equal to the normalized actual waybill,
  matching `#main.__vue__.num`, and `checkCode.show === true`. The script writes the
  normal input's `checkCode.value` model and invokes `doCheckCode()` at most once.
  It never reads the input back, searches other bindings, or adds the suffix to the URL,
  logs, exceptions or results. The existing loaders, eight-second limit and cooldown stay unchanged.
- Each K100 capture emits one scalar terminal diagnostic: evaluation/failure counts,
  main-root presence, fixed ready-state enum, challenge visibility, valid-track count,
  numeric main-frame error or HTTP status, and exit reason. Missing page fields remain
  unknown. `phoneVerificationAttempted` records the observed one-time submission claim,
  not upstream acceptance. No extra evaluation or page load is added for diagnostics.
- ShunFeng source uses Meizu first, never Moto, and keeps its account package as
  the final coarse cache.
- An active ShunFeng parcel cannot skip a detail refresh merely because its
  cached history aligns with the coarse feed. Terminal cache freezing and the
  existing Meizu/primary/fallback gates remain unchanged.
- Lite follows Meizu, then Kuaidi100 H5, then the original account data fallback;
  it does not add Moto, OPPO, or KDNiao to the ShunFeng chain.
- Any usable Meizu or Kuaidi100 package precedes the
  account feed/query and automatic H5 in ShunFeng Home/list and detail, including partial manual history.
  Those automatic packages remain fallback-only and cannot close the active
  ShunFeng manual-history gate. No new provider or network fallback is introduced.
- Among eligible same-parcel manual packages, the shared ShunFeng display selection
  uses their latest timed event as the reference. Pickup evidence, the 30-minute tolerance, sticky
  selection, and provider package boundaries remain unchanged. Other sources
  retain their feed reference; terminal refresh behavior remains unchanged. The
  existing Online-only list query and its status/polling authority remain separate
  from this display choice; selecting K100 never starts a list capture.
- Meizu gateway requests, responses and parser outcomes use `v6_query` for Online.
  Response diagnostics record only mode, HTTP status, a finite integer
  upstream code when available, value type, redirect presence, waybill tail, and
  duration. Parse diagnostics distinguish identity mismatch, missing parcel object,
  provider-error-only empty history, and acceptance using fixed outcomes and a node
  count. Response messages, values, and URLs are never emitted by these diagnostics.
- JingDong exists only on Interface 5. Home and detail apply the same current
  account-query and unresolved-waybill gates before JD H5. Home holds an order
  lease during the account query; a timed response or query text projection
  skips H5 without consuming its cooldown. Only the permitted H5 load claims
  the shared ten-minute cooldown. Eligible JingDong manual supplementation ends
  after Meizu and never calls Moto, K100 H5 or KDNiao.
- Interface 5 Cainiao follows iOS: use the automatic package directly when it
  has PICKED; a stateful package without PICKED may capture its own trusted
  Cainiao H5 into an isolated cache, then run the eligible ordinary manual chain
  without KDNiao if still incomplete. Empty or UNKNOWN packages do not qualify
  for that H5 partition. Interface 6 Cainiao opens its trusted same-owner H5
  directly; it does not scrape, use local manual sidecars or enter that chain.
  The row owner selects this partition, regardless of the currently selected
  account interface.

## Refresh scheduling and persistence

- Lite pull-to-refresh consumes only the completion of its requested WorkManager
  job. Each execution owns its request counters; overlapping background jobs
  cannot end the foreground gesture or replace its result.
- Foreground and background runs use the same provider policy. Background work
  is host-safe and does not open a visible WebView.
- Active unsigned shipments, including manual rows and eligible source-takeover
  rows, are enrolled in background polling. Current-run start evidence only
  saves downstream calls for that run.
- iOS provider schedules are independent. Success cooldowns, classified failure
  backoff, and stable jitter prevent synchronized retries without blocking
  unrelated providers. Its durable cross-runtime leases coordinate the app,
  widget, intent, and background runner.
- After iOS account-list synchronization and identity projection, independent
  shipment work shares four task slots, with at most two manual or pending
  tasks. A completed task immediately frees its slot. Automatic supplementation
  waits only for its own scheduled account query and rechecks eligibility after
  that query; standalone manual rows can start without waiting for account
  details. Provider order, terminal-state gates, cooldowns, and host deadlines
  remain authoritative within each task.
- Queued iOS tasks re-read durable state before starting. Each task commits
  against its own read baseline, so parallel results cannot replace newer row
  edits. Cancellation or checkpoint failure stops further admission and commits,
  aborts active work, and waits for it to settle. Completed checkpoints remain
  durable.
- A route-only manual result releases its own query lease in its result
  checkpoint. Route sidecars still publish before their state pointers; an
  unchanged pointer skips the whole-state write only after validating every
  target version. The guarded lease cleanup remains for concurrent row changes.
- Android uses transactional owner claims plus finite WorkManager retries so
  foreground and background refreshes cannot concurrently own the same manual
  timeline.
- Widget freshness is based on the last successful network refresh, not a local
  cache write.
- Notification aggregation is intentionally unchanged.

## iOS notification delivery

- Refresh checkpoints persist `pendingNotifications` in the same state envelope
  as the business changes. A full refresh compares against its initial snapshot,
  suppresses first-seen shipments, and coalesces each shipment within that refresh
  batch to its final state. Unacknowledged events from earlier batches remain.
- A timed-out or superseded full refresh cannot commit late results. A subsequent
  full refresh replays already committed events even when the source returns no
  further change.
- Successful scheduling, a deleted shipment, or the current notification
  preferences making an event inapplicable permits durable acknowledgment.
  Scheduling or acknowledgment failure retains the event for another attempt.
- Scripting does not document a caller-provided notification ID or replacement
  contract. A crash after scheduling succeeds but before acknowledgment can
  produce a duplicate notification; delivery is not exactly once.

## Lite notification delivery

- A qualifying visible change and its notification obligation commit in the
  same SQLite transaction. Outbox failure rolls back that business update.
- `express_notification_outbox` stores only an owner row ID and a revision
  token. It coalesces each row to its latest committed presentation, preserving
  batch aggregation and suppression for rows first discovered in that batch.
- Delivery happens after commit, at the outer batch boundary, and during
  process startup maintenance. A posting failure retains the obligation for
  the next attempt; acknowledgment deletes only the matching revision.
- Deleted rows are discarded. Unsupported notification states or denied
  notification permission retain the existing skip policy. Successful replay
  uses the same Android notification ID and `setOnlyAlertOnce(true)`; SQLite
  and the system notification service do not share one atomic transaction.

## Failure boundaries

- Empty, timed-out, rejected, cancelled, or late responses cannot erase a
  successful provider cache.
- Required durable writes complete before best-effort UI feedback, widget
  reloads, or notifications.
- A route is opened only after scheme, host, credential availability, and
  source ownership pass the platform-specific trust checks.
- Deleting or manually completing a shipment is an idempotent state mutation;
  it does not terminate the Scripting process or navigate to the host app.
