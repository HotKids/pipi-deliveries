# Express runtime delivery boundaries

Updated: 2026-09-14. The duplicated iOS/Lite provider matrix formerly in this file is superseded by the repository-wide [three-client call matrix](../../docs/EXPRESS_RUNTIME_LOGIC.md). Use that reference for list, detail entry, pull, manual addition, identity, carrier and phone calls on **all three clients**.

- [Chinese operator reference](../../docs/EXPRESS_TIMELINE_SELECTION_CURRENT.zh-CN.md)
- [Cache, selection, status and diagnostics](../../docs/EXPRESS_TIMELINE_SELECTION_CURRENT.md)
- [Allowed differences and dated amendments](../../docs/EXPRESS_THREE_CLIENT_PARITY_20260901.md)

The independent notification and failure-boundary notes below are retained. They do not grant additional provider calls or override current status/terminal rules.

## iOS product image first frame

The detail thumbnail resolves memory and then the retained record's immutable
local image before its first render. Existing cache files remain readable without
an image URL or network request. A missing or damaged cache keeps the carrier icon
and the existing asynchronous image loading path.

Downloads and temporary URL caches still pass ImageIO metadata validation before
UIImage creation. Immutable record files are published only after that validation;
their synchronous first-frame restoration checks the file and actual data against
the 4 MiB limit, creates the native image container at scale 1, checks its pixel
dimensions against the 16 Mi-pixel limit, and prepares the existing 432-pixel
thumbnail. It rechecks that lifecycle cleanup has not excluded the exact file
before remembering the image. First-success retention, record ownership and
deletion/expiry cleanup remain unchanged.

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
- An ordinary delivery event consumed by the live-activity policy first cancels
  the same row's previous ordinary notification. The live switch does not revive
  ordinary delivery alerts; waiting-pickup and other state rules remain unchanged.
  A cancellation exception leaves the existing outbox obligation available to retry.

## Failure boundaries

- Failed, timed-out, rejected, cancelled, or late observations cannot erase
  qualified provider history. Accepted account-list snapshots, including an
  empty snapshot, follow the separate current cache-admission contract.
- Required durable writes complete before best-effort UI feedback, widget
  reloads, or notifications.
- A route is opened only after scheme, host, credential availability, and
  source ownership pass the platform-specific trust checks.
- Supported row actions are idempotent state mutations. iOS deletion and manual
  sign-off do not terminate the Scripting process or navigate to the host app;
  this does not add manual sign-off to Lite or Pipi.

## Lite account-query cache ownership

- Retained Interface 5 history remains in its existing normalized-waybill table.
  Current detail selection, status donors, projection and query-completeness gates
  require its owner attribution to match the live row, projected identity,
  business source, adapter and current binding generation. An unqualified
  account order can retain its own query under that identity without establishing
  automatic ownership; another automatic owner still blocks the query.
- The existing `owner_presentation` payload also retains the current attributed
  packet. Successive packets merge only inside that attribution. The global
  historical bytes remain available without donating old-owner status or history
  to the new owner's current packet. Older matching attributed payloads remain
  readable; no database migration or historical-cache deletion is required.
- First manual addition previews Online, then reaches the existing K100 primary
  or official JT alternative when Online cannot close the start gate. Each stage
  is capped at 15 seconds, the existing H5 capture remains capped at 8 seconds,
  and the whole first-add operation is capped at 30 seconds. All results still
  commit with the final owner atomically; leaving the screen cancels the chain.
