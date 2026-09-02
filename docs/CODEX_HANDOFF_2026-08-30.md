# Codex handoff — 2026-08-30

## 2026-09-01 JD/K100 update

- `0.5-beta21` / client build 27 preserves the Xiaomi order-completion
  semantic for an unprojected JingDong order. Only an actual pickup semantic
  is remapped to the order-number presentation `ORDERED`; the text
  `订单…已完成` remains `COMPLETED` even when legacy cached state had labelled
  it `ORDERED`.
- `0.5-beta20` / client build 26 removes two serial homepage requests that
  could not change its canonical Xiaomi presentation. JingDong rows retain the
  account-list increment without a separate `account_detail` request, while a
  Cainiao row enters the Moto fallback only when Xiaomi returned no timed
  tracks. Detail pull, Kuaidi100, pending queries, manual shipments, and
  ShunFeng behavior are unchanged.
- `0.5-beta19` / client build 25 removes the persisted Kuaidi100 query
  cooldown. Every real detail pull may issue a new request; an upstream rate
  limit fails only that refresh. The page-level in-flight coalescing and the
  finite request timeout remain in place. Success, no-track, timeout, and
  controlled upstream failures are returned to the detail page as normalized
  toast messages; raw upstream response text is never displayed.
- `0.5-beta18` / client build 24 renders the incomplete-track hint as the
  native timeline section footer, without a separate card or separator.
- Kuaidi100 result diagnostics now retain only the detected carrier, response
  shape, raw/parsed/timed node counts, and a bounded exit reason. They never
  retain the response body, full waybill, or phone tail.
- JingDong's authenticated H5 is now identity-only. Its captured timeline is
  discarded before state commit and is used only to obtain the real waybill.
- Projected JD details and recognized manual JD queries bypass Meizu Picker and
  POST the waybill plus four-digit phone tail directly to the fixed Kuaidi100
  web query endpoint in the background. No Kuaidi100 page is opened.
- Existing `kuaidi100_h5` tracks remain available and merge incrementally.
- Account-detail requests use native abort signals for their five-second child
  budgets, and each diagnostic duration now ends when that request settles.
- A timed `kuaidi100_h5` package now owns JD detail presentation even when the
  account cache has a one-node terminal summary; providers remain unmerged.
- Kuaidi100 timeline requests now run only after a JD detail pull. The request
  first resolves the carrier through Kuaidi100 auto-detection and accepts the
  timeline only when the response carrier matches.
- The Xiaomi account package remains canonical for the list, widget, and
  notifications. Kuaidi100 is a detail-only overlay, and unverified legacy
  Kuaidi100 packages are discarded during state normalization.

Snapshot time: 2026-08-30 15:36 CST

This handoff is the continuation point for Android Lite and iOS Scripting work.
It records verified evidence, current boundaries, and the shortest next
validation path. Do not reconstruct the task from screenshots or restart from
the repository baseline.

## Start here

- Repository: `/Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown`
- Branch: `codex/android-one-hour-cooldown`
- Snapshot HEAD: `892ea72d8ddfaa8a1d209cb557d304b67490d080`
- The worktree contains extensive, related, uncommitted Android and Scripting
  changes. They are the current source of truth. Do not reset, checkout, clean,
  or recreate them from GitHub.
- Read [EXPRESS_RUNTIME_LOGIC.md](./EXPRESS_RUNTIME_LOGIC.md) before changing
  query ownership, source routing, timeline authority, refresh, or persistence.
- The immediate next action is runtime validation of the 15:30 iOS package,
  not another speculative code change.

Suggested first prompt in the next Codex window:

> Continue from `docs/CODEX_HANDOFF_2026-08-30.md`. Reimport the 15:30 Desktop
> Scripting package, reproduce 7226 and 9613, and inspect the fresh diagnostic
> flow before changing code.

## Scope and authority

Current authorized implementation scope:

- Android Lite in this repository.
- iOS Scripting in `script/project`.

Current excluded scope:

- Shared Cloudflare Worker changes.
- Pipi Assistant changes.
- Server deployment.

The Worker and Pipi work is intentionally deferred until that implementation is
reconciled. Do not introduce a client-specific Worker branch or deploy a Worker
from this task without a new explicit request.

Specification precedence:

1. `/Users/joey/Downloads/EXPRESS_OWNERSHIP_PLAN_FINAL.md`
2. `/Users/joey/Downloads/BUILTIN_CARRIERS_FINAL.md`
3. [EXPRESS_RUNTIME_LOGIC.md](./EXPRESS_RUNTIME_LOGIC.md)
4. Current client implementation and tests

The KDBot authoritative built-in carrier table has not yet been integrated by
the shared Worker/Pipi work. Until then, both clients use the temporary table
defined by the two canonical documents above.

## Latest iOS incident and fixes

### Cainiao route sidecar transaction

Observed failure:

- A shipment could have `routePointerPresent=true` while `routePresent=false`.
- The route URL sidecar was written first, then a state load pruned it against
  the old pointer state before the new pointer was durably committed.

Fix:

- `script/project/services/storage.ts` no longer destructively prunes route
  sidecars during `loadState()`.
- Route cleanup remains after the durable state and mirror write succeeds.
- The regression is covered in `script/project/tests/storage.test.ts` by the
  sequence “write sidecar → publish pointer → read pointer and URL”.

Runtime evidence:

- The user's 15:20 diagnostic flow showed 9613 and other Cainiao shipments as
  `routePresent=true` and `routeTrusted=true`.
- This confirms the sidecar transaction fix on a real device.

### Targeted account detail must preserve a valid Cainiao route

Observed failure in the user's 15:20 flow:

- Shipment 7226 began account-detail refresh with a Cainiao route pointer.
- Account detail returned nine effective tracks.
- Reacquisition then changed it to `routeKind=none` and the H5 stage skipped
  with `route_pointer_missing`.

Root cause:

- A detail response can contain updated tracks without repeating the H5 route.
- Automatic ownership reacquisition treated the absent route as an instruction
  to clear the already valid pointer.

Fix:

- `script/project/services/shipment-policy.ts` preserves the existing pointer
  only when the old sidecar is actually readable and both the previous and new
  business source remain Cainiao.
- The two detail-refresh call sites in `script/project/services/sync.ts` pass
  the sidecar-availability fact into that policy.
- A real provider change, including Cainiao to ShunFeng or JingDong, still
  clears the old route.
- Regression coverage is in
  `script/project/tests/shipment-policy.test.ts`.

Status:

- Code and tests passed.
- This fix is included in the 15:30 package.
- It has not yet been validated on the physical iOS runtime after importing
  that package.

### Eight-second widget refresh deadline

Observed failure:

- Widget-host flows used `budgetMs=8000` but emitted
  `account.sync.failed errorCategory=timeout durationMs=0`.
- These failures were not ordinary network timeouts; the request deadline had
  already expired before the HTTP request could start.

Root cause:

- The eight-second widget budget lost three seconds to finalization reserve and
  then ten seconds to account-followup reserve.
- The resulting child deadline was already in the past.

Fix:

- `script/project/services/refresh-mode.ts` defines a bounded
  `backgroundHostSafe` profile.
- Widget refresh now performs account-list synchronization and durable
  checkpoints only.
- It does not run order projection, WebView/H5 enrichment, account-detail
  followups, manual fallback, or pending queries.
- Widget-origin checkpoints do not call `Widget.reloadAll`, preventing a
  cross-widget refresh feedback loop.
- The account list receives approximately five seconds of real request budget.
- Tests are in `script/project/tests/widget-runtime.test.ts` and
  `script/project/tests/account-sync-policy.test.ts`.

Status:

- Code and tests passed.
- This fix is included in the 15:30 package.
- The 15:21 `durationMs=0` logs came from the previously imported runtime and
  do not validate or invalidate the new package.
- A real widget-host run after reimport is still required.

### Account-detail rotation

- Only one account-detail followup is intentionally selected per full refresh.
- A shared durable cursor now rotates the selection instead of repeatedly
  choosing the same shipment for 30 minutes.
- Cainiao shipments without tracks are prioritized.
- The cursor is `pipi_deliveries_account_followup_cursor_v1`.
- Coverage is in `script/project/tests/account-sync-policy.test.ts`.

### Detailed diagnostics

- iOS keeps up to 500 records for seven days.
- Records preserve refresh flow/stage, four-character waybill tail, business
  source, carrier, route pointer/presence/trust, WebView extraction signals,
  track counts, persistence/provider result, budget, duration, and error class.
- The diagnostic page reloads the freshest complete log list before copying.
- Privacy filtering still excludes full waybills, phone numbers, verification
  codes, Access Keys, full H5 URLs or credentials, and response bodies.
- Implementation: `script/project/services/logger.ts` and
  `script/project/pages/DiagnosticLogPage.tsx`.

Documentation drift:

- `script/README.md` still says diagnostic logs retain 100 records. The current
  implementation retains 500. Update that sentence in a later documentation
  pass; do not reduce the implementation to match the stale README.

## Latest iOS runtime evidence

The last pasted logs came from the runtime active around 15:20–15:21.

| Shipment tail | Evidence | Current interpretation |
| --- | --- | --- |
| 9613 | Account detail succeeded with three timed YTO tracks. Later route entries were trusted and present, but that refresh marked the item `batch_deferred`. | The route-sidecar fix is proven. Cainiao H5 extraction for this shipment is not yet proven because it was not selected after the route recovered. |
| 7226 | Account detail succeeded with nine tracks, then the route became `none` and H5 skipped `route_pointer_missing`. | Direct reproduction of the targeted-route clearing bug. The 15:30 package contains the fix but needs device validation. |
| 0246 and other deferred Cainiao items | `routePresent=true` and `routeTrusted=true` in the 15:20 flow. | Confirms route sidecars can now survive normal state loads. |
| Widget/account-list flows | Repeated `budgetMs=8000` and immediate `durationMs=0` timeout. | Old imported package still had the deadline bug. Reimport and test the 15:30 package. |

Adjacent warnings are separate problems and must not be used as substitutes for
the Cainiao fixes:

- `order.projection.committed result=extracted_not_committed` for some
  JingDong owners.
- `manual_refresh result=no_result` when all final manual fallbacks return no
  qualifying package.

The initial reason every route sidecar disappeared is not fully proven. A
likely trigger is replacement of the per-script Keychain namespace during a
reimport while App Group state survived. The repeated self-deletion after that
trigger was proven and fixed. Preserve that distinction.

## Current cross-platform runtime contract

The complete implemented contract is in
[EXPRESS_RUNTIME_LOGIC.md](./EXPRESS_RUNTIME_LOGIC.md). Important invariants:

- Business source (`sourceProvider`) and physical carrier are independent.
- A JingDong-source SF shipment follows JingDong source rules; it does not
  enter ShunFeng takeover merely because the carrier is SF.
- Only `sourceProvider=ShunFeng` activates the manual timeline takeover.
- Cainiao source:
  - Android opens the shipment's own credentialed H5 and falls back to the
    persisted local package.
  - iOS may extract the shipment's trusted H5 only in a foreground-safe host.
  - Widget-host refresh never performs WebView work.
- JingDong source:
  - iOS retains the source-issued projection reference and tries source-owned
    H5 before cross-source manual fallback.
- Manual provider chains use concurrent local and route capabilities. Android
  may then use the user's configured paid Kuaidi100 account; iOS may then use
  KDNiao. Removed providers are not queried.
- Meizu Picker uses the existing shared Worker contract
  `interface=v6, mode=manual`.
- The keyless carrier recognition endpoint
  `www.kuaidi100.com/autonumber/autoComNum` is called directly by both clients.
  It is separate from the paid Kuaidi100 timeline endpoint and remains the
  first carrier-presentation recognition level.
- Paid `poll.kuaidi100.com/poll/query.do` is timeline fallback only.
- Timeline nodes from different providers are never concatenated.
- Complete package wins; then latest trustworthy provider event time; then the
  fixed provider order as an exact tie-breaker.
- A failed refresh must retain the last successful provider package.
- App list, detail, widgets, and notifications read the same persisted iOS
  state. Successful refresh checkpoints persist before widget/notification
  side effects.
- iOS initial open and resume reload local state and start a coalesced refresh;
  pull-to-refresh forces a refresh.
- WidgetKit is requested to run no earlier than 15 minutes later, but the OS
  controls actual scheduling.

## Android Lite status

### Query behavior

- The current Android free phase runs local and route capabilities concurrently.
- The user's configured paid Kuaidi100 account is explicit final fallback only.
- Meizu calls the shared Worker with `interface=v6, mode=manual` and persists a
  qualifying timed result as its own owner-scoped manual timeline package.
- The Meizu Kuaidi100 detail URL is presentation-only H5 fallback. It must not
  overwrite automatic owner route, business source, or `sourceProvider`.
- Switching automatic account interface does not duplicate manual shipments,
  pending queries, or manual provider sidecars.

### Last build validation

The last full Android validation passed 103 Gradle tasks, including unit tests,
lint, and both debug variants:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
./gradlew :app:testStandardDebugUnitTest :app:testCompatDebugUnitTest \
  :app:lintStandardDebug :app:lintCompatDebug \
  :app:assembleStandardDebug :app:assembleCompatDebug
```

Artifacts:

- `app/build/outputs/apk/standard/debug/app-standard-debug.apk`
- `app/build/outputs/apk/compat/debug/app-compat-debug.apk`

The current source/APKs were not installed during the latest iOS-focused pass.
Physical-device install state and runtime behavior are therefore unverified.

### Current UI contracts

These are the current source-level product contracts. Treat real-device visual
results as unverified until captured after installing the current APK.

- Android 2 × 2: carrier icon on the left; status/company text uses the current
  responsive layout equivalent to 20/12 at the reference size; carrier and
  waybill tail are shown; capsule contents are vertically centered.
- iOS 2 × 2: carrier icon on the right; left side shows status, then carrier and
  waybill tail; current reference typography is 20/12.
- 2 × 2 empty search geometry aligns with 4 × 2, including top/trailing
  responsive inset.
- Android 4 × 2 remains based on the Pipi multi-delivery card behavior, has no
  ad-hoc scrolling, retains `我的快递 {count}`, and keeps carrier-derived search
  tint.
- Android and iOS empty state treat the SF vehicle and `暂无快递` label as one
  centered unit in the body area excluding the header.
- Home-page empty-state SF vehicle scale is 1.2×.
- Both list pages show `只显示 7 天内的快递信息` as list content rather than a
  viewport-fixed footer.
- Android binding copy is:
  `最多可绑定 5 个手机号；绑定后，将自动同步关联的快递信息。`
- Binding privacy copy is:
  `隐私声明：绑定的手机号仅用于查询快递，不作其他用途。`

Do not infer dimensions from screenshots when source from Pipi or either client
is available. Read the reference implementation and use screenshots only for
post-implementation verification.

## iOS package and validation

The latest package was produced after all current route-preservation and widget
budget changes.

- Script version: `0.5`
- Repository artifact:
  `/Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown/script/pipi-deliveries.scripting`
- Desktop artifact: `/Users/joey/Desktop/pipi-deliveries.scripting`
- Size: 881176 bytes
- SHA-256 for both copies:
  `e7c33da70b70c1e467d09066a496310556a4315b7a332d7f4262a30aafebaa1d`
- Desktop modification time: 2026-08-30 15:30:17 CST

Validation already completed:

```sh
cd /Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown/script/project
sh tools/test.sh
sh tools/package.sh
sh tools/verify-package.sh
```

All Scripting tests passed, the package verified, and `git diff --check` passed
at that point. This is source/package validation, not a physical-host E2E test.

## Next runtime validation

Do these steps in order and inspect one complete diagnostic `flowId` before
editing more code:

1. Import `/Users/joey/Desktop/pipi-deliveries.scripting` into Scripting and
   confirm it is the 15:30 package above.
2. Open the app and use pull-to-refresh.
3. For 7226, verify that account-detail refresh does not clear the route:
   `routeKind=cainiao`, `routePointerPresent=true`, and `routePresent=true`
   must remain true after the detail checkpoint.
4. Continue foreground refreshes until the durable cursor selects 9613.
5. For 9613, verify a selected `cainiao_h5` stage starts with
   `routePresent=true` and `routeTrusted=true`.
6. Accept H5 success only with persisted timed tracks. If it fails, use the new
   extraction/exit evidence to diagnose the H5 page itself rather than adding
   another provider fallback.
7. Allow one widget-host refresh and verify:
   - account-list request receives a future deadline and roughly five seconds
     of usable budget;
   - it no longer fails immediately with `durationMs=0`;
   - the same widget flow does not run projection, H5, account-detail,
     manual-refresh, or pending-query stages.
8. Verify list, detail, 2 × 2, 4 × 2, and notifications show the same committed
   shipment state after a successful checkpoint.

## Known open items

- Manual-query completion currently appears to insert the shipment into the
  list without presenting its timeline. The expected interaction is: after a
  successful manual query produces a qualifying timed package, open that
  shipment's trajectory/detail page exactly once. Returning from the detail
  page must show the same persisted shipment in the list, and later refreshes
  must not reopen the page. First reproduce and identify whether the observed
  direct-insert behavior is Android, iOS, or both; then fix the owning
  navigation boundary without bypassing the existing provider-package cache,
  pending-query rules, or timeline authority. The user has not requested a
  change to whether persistence occurs before or after the one-shot preview,
  so determine that separately from current product behavior and reference
  source rather than assuming it.
- Physical iOS validation of the 7226 targeted-route fix.
- Physical iOS validation of Cainiao H5 extraction for 9613 after its route
  recovered.
- Physical iOS validation of the widget-host-safe 8-second refresh profile.
- Separate diagnosis of JingDong `extracted_not_committed` if it still occurs
  after the Cainiao validation is complete.
- Real-device logged-in JingDong H5 extraction remains unverified.
- Strict no-loss behavior during simultaneous App and Widget writes is not
  guaranteed by the current synchronous App Group store. This requires a real
  transactional owner, not another advisory fallback.
- Android current-APK install and visual verification on Fold7 and S26U.
- `script/README.md` must be updated from 100 to 500 diagnostic records.
- `docs/EXPRESS_RUNTIME_LOGIC.md` currently contains one duplicated sentence
  at the automatic-ownership section; it is harmless documentation drift.

## Device operations

For any Fold7 or S26U request, use the global Android connection helper before
asking for pairing information:

```sh
/Volumes/SAMSUNG/joey/CodexData/.codex/skills/android-device-connection/scripts/device.sh
```

Verified fixed endpoints and models:

- Fold7: `192.168.31.22:5555`, model `SM-F9660`
- S26U: `192.168.31.2:5555`, model `SM-S9480`

Always verify the model returned by ADB. Never substitute S26U for Fold7 or ask
for a new wireless port before letting the helper recover the paired mDNS
identity. When asked to view a phone screen, capture that named physical device
through ADB; do not substitute a browser, desktop, or mirroring window.

## Operational guardrails

- Preserve the dirty worktree. Do not discard, stash, or overwrite unrelated
  changes.
- Do not use GitHub as a visual-layout baseline: the repository baseline was
  already known to include unwanted historical edits.
- Do not estimate implementation constants from screenshots when reference
  source is readable.
- Do not add a fallback until the failing primary path has been instrumented
  and its root cause established.
- Keep business source, physical carrier, route credentials, and presentation
  normalization separate.
- Do not log or paste full waybills, phone numbers, Access Keys, H5 credentials,
  or response bodies.
- Do not claim a physical-device result from unit tests or package verification.

## Useful commands

Inspect the worktree without modifying it:

```sh
cd /Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown
git status --short --untracked-files=all
git diff --check
```

Validate and package iOS Scripting:

```sh
cd /Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown/script/project
sh tools/test.sh
sh tools/package.sh
sh tools/verify-package.sh
```

Validate Android Lite:

```sh
cd /Volumes/SAMSUNG/joey/flyme-mod/pipi-deliveries-android-cooldown
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
./gradlew :app:testStandardDebugUnitTest :app:testCompatDebugUnitTest \
  :app:lintStandardDebug :app:lintCompatDebug \
  :app:assembleStandardDebug :app:assembleCompatDebug
```
