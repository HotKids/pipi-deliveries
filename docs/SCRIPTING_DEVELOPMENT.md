# Scripting development and packaging

This guide is for maintainers. The installed package's [README](../script/README.md) is the user guide.

## Owning files

`script/project/` is the source of the Scripting app. `script/pipi-deliveries.scripting` is its generated ZIP package. Work in the canonical Pipi Assistant workspace's `deliveries/` directory; the independent `HotKids/pipi-deliveries` repository remains a distribution mirror, not another development checkout.

The package contains `script/README.md` as its root `README.md`, followed by the runtime entry points, shared modules, contracts and assets. Tests and tools stay outside the package. The verifier compares every packaged file with its owning source, checks required entries, and rejects unexpected files, disallowed material and network URLs. A README-only change still requires regenerating the package.

Current entry points are `index.tsx` (app), `widget.tsx` (Home Screen widgets), `intent.tsx` (Shortcuts) and `app_intents.tsx` (registered refresh intent). The native Scripting host is required; this is not an independent IPA.

## Background hosts and optional caches

Widget, Shortcuts and the registered App Intent share the cache-only bootstrap and refresh options in `services/background-refresh.ts`. Bootstrap installs the existing last-good carrier authority cache without fetching it. Keep each host's current call order and budget. The shared options still pass `accountOrderProjection: true`; the owning `fullRefreshHostPolicy` disables it for background hosts.

The registered App Intent keeps a void result contract. Its error boundary rejects with the existing safe refresh-failure message, including bootstrap failures. The installed declarations allow a generic return type, but the [official AppIntent documentation](https://scriptingapp.github.io/guide/AppIntent.md) does not establish text-result presentation. Do not substitute the separate Shortcuts `Intent.text` API.

Product-image pruning takes one directory inventory per call. Successfully created deletion markers join that inventory so they replay immediately. Existing immutable-file markers, optional cleanup failures and the 20-second pending-writer deadline remain unchanged. Do not reuse an old process-local inventory to skip another host's deletions.

## Diagnostic buffering

Single diagnostic records are sanitized before entering a process-local buffer. Flush occurs at the end of the current tick, at 20 queued records, on full-refresh terminal records, on read/export, and before host exit or widget presentation. Explicit `writeDiagnosticBatch` remains synchronous and includes preceding buffered records. Recording disabled or a successful clear discards pending records; the existing 200-record/seven-day retention and exported text format remain unchanged.

The owner accepted losing unflushed records when a runtime dies. Published records use `services/diagnostic-store.ts` under the shared App Group's `pipi-deliveries/diagnostics-v2`. Each flush prepares an independently named batch, verifies individual immutable record files, then publishes its `.ready` symbolic link. Readers never accept a batch before that publication. A lost publication acknowledgement is checked against the same ready link before retrying; app and widget writers never overwrite a shared log array. Filenames contain only internal UUIDs, counters and clocks.

Clear publishes an immutable marker containing an ordered sequence and UUID in its filename. Concurrent clears with the same sequence have a deterministic order. Every enqueue and flush reads the current marker; buffered records retain the epoch they observed, rather than using a process-local cache as authority. A later flush cannot move pre-clear records into the new epoch. New records enqueued after a completed clear use the new epoch. Old shared-array records remain readable until a verified, sanitized immutable migration is published; the migration marker precedes best-effort removal of the old array. A clear never reimports that retired array.

Reads merge published batches by internal publication order and deduplicate record IDs. Retention removes individual files outside the existing 200-record/seven-day window, including partially retained batches. A cleaner only deletes current-epoch rows from its own read snapshot, so it cannot delete a batch published concurrently. Records newer than that snapshot's clock are left for the next read. Older clear epochs and expired unpublished staging directories are cleaned without changing business-state retention. Unflushed staging files are never accepted as durable diagnostics.

Recording disabled discards pending records. Missing or failing native file APIs preserve a bounded sanitized buffer for retry; there is no non-atomic shared-array write fallback. A buffer already tagged with an epoch stays hidden unless a fresh read confirms the same epoch, including when the native file bridge fails after another runtime clears. A new buffer that has never observed a file epoch can still expose its sanitized capability warning, but cannot publish into an existing clear epoch. Failure of optional logging never fails a parcel refresh. The existing text export and diagnostic privacy whitelist remain unchanged. Shared-file concurrency, clear ordering, capability failure after another process clears, process death before publication, lost acknowledgements and physical retention are exercised with separate Node processes and a synthetic App Group. Actual iOS host performance and filesystem integration still require device validation.

## Source checks and packaging

Run these commands from the Deliveries directory (`deliveries/` in the canonical workspace):

```sh
sh script/project/tools/test.sh
sh script/project/tools/package.sh
sh script/project/tools/verify-package.sh script/pipi-deliveries.scripting formal source
```

The behavior suite uses Node.js 24 in CI and the repository's TypeScript loader. Packaging requires a POSIX shell, Python 3, `zip`, `unzip` and `rg`; missing `rg` is a hard verification failure. A Git work tree additionally requires Git: packaging and verification select indexed files and read their current working-tree contents, excluding untracked and ignored files. A downloaded source archive with no enclosing Git metadata uses the files in the same allowed runtime paths and does not require Git. Both modes exclude dot-path components and Markdown files in runtime directories; top-level tests and tools are outside the selected runtime paths. Other non-hidden files within those paths are included (there is no extension allow-list). Both modes use `script/README.md` as the package README. The discovered Git work tree must contain this project and track its `script.json`; an archive nested inside an unrelated checkout fails with an ownership error. A missing Git executable, unreadable index or invalid worktree metadata in a checkout remains a failure; it cannot switch that checkout to archive mode. Temporary packaging and verification files stay under the owning canonical repository, mirror or standalone source tree in `project-data/tmp`. The package tool writes a temporary archive, verifies it, then replaces the requested output. The default purpose is `source`, which permits an undeployed candidate but does not authorize distribution, a mirror push, a deployment or a Release.

For native API type checks, use declarations synchronized from the installed Scripting App with `scripting-cli`, together with the [official documentation index](https://scriptingapp.github.io/llms.txt). Repository behavior tests and package checks do not prove real WidgetKit scheduling, host permissions or notification delivery; those require the actual iOS host.

## Version and track selection

`script/project/script.json.version` must equal `SCRIPT_VERSION` in `services/build-track.ts`; these declarations are the source of truth for the current version. Read the selected track, client build, origin and gateway protocol from that same `build-track.ts` declaration rather than copying their values into this guide.

Advance only the final numeric version component when the delivered iOS code, runtime configuration, contracts or resources change: `0.7.9 → 0.7.10 → 0.7.11`. It never carries into the minor or major component. Android, documentation, development-tool and test changes alone keep the existing iOS version. From the canonical Pipi Assistant root, run `python3 tools/verify_deliveries_mirror.py --prepare` before committing the candidate. This compares the delivered iOS payload with the destination's exact main commit, excluding version declarations and documentation, then selects the required version and regenerates the package; repeated preparation before publication is idempotent. Commit the reviewed result to local main, then run `python3 tools/verify_deliveries_mirror.py --publish` immediately before exporting the mirror. Publication checks the committed payload and version against the current destination main using the same rule. The default command without flags retains the offline protocol check.

An explicit user-selected version overrides that rule for the named publication only. Use the same `--set-version VERSION` argument for `--prepare` and `--publish`. The selection must be a valid three-component numeric version and may be older than, equal to or newer than the mirror baseline. The owner's 2026-10-26 restoration to `0.9.2` with client build `36` was one such publication-specific request, not a standing override for future mirrors. Later ordinary publications apply the payload-change rule to the version then on mirror main. An explicit version selection preserves the existing track, beta suffix, protocol and client build.

This version step does not create a GitHub Release or change the gateway track, protocol or client build. The GitHub main download serves the latest mirrored archive; automatic installation on a user's device remains controlled by the Scripting host and its configuration.

The formal release-counting baseline is `0.6.2 / build 34`; each subsequent formal iOS release increments `SCRIPT_CLIENT_BUILD` by exactly one. Beta packages retain the last formal build and use a `-betaN` version suffix. The formal version must not contain that suffix. Beta uses `https://beta.pipiassistant.app`; formal uses `https://pipiassistant.app`.

`SCRIPT_BUILD_TRACK`, `GATEWAY_ORIGIN` and `SCRIPTING_GATEWAY_PROTOCOL_VERSION` are explicit package declarations. Android's beta builder and Worker promotion do not select them for Scripting. The v2 implementation constant in `scripting-auth.ts` is not the package's protocol selector.

## Client and Worker pairing

| Target artifact | Track | Origin | Selected protocol |
| --- | --- | --- | --- |
| Current v1-only formal, before the legacy deadline | `formal` | `https://pipiassistant.app` | `1` |
| Beta supporting v2 | `beta` | `https://beta.pipiassistant.app` | `2` |
| Formal promoted to v2 | `formal` | `https://pipiassistant.app` | `2` |

Protocol v1 signing and delivery stop at **2026-11-01 00:00 Asia/Shanghai**. A failed request never retries with another protocol or origin. Delivery verification requires the highest supported protocol in the exact target artifact; a v2 target rejects a remaining v1 client selection.

Before distributing an archive, the release owner must verify the exact active target Worker and its readiness. Pass that artifact's absolute local path as `verified_worker`:

```sh
sh script/project/tools/package.sh "$PWD/script/pipi-deliveries.scripting" delivery "$verified_worker"
sh script/project/tools/verify-package.sh "$PWD/script/pipi-deliveries.scripting" formal delivery "$verified_worker"
```

Use `beta` instead of `formal` when verifying a beta package. Delivery mode performs offline compatibility checks against the supplied artifact; it does not establish live deployment identity, key readiness or authorization to publish. Keep the workspace's Worker release and mirror gates in force.

## Credentials and local state

`services/credentials.ts` owns the Access Key in the script's local Keychain scope; `services/scripting-activation.ts` owns the separate activation identity in its synchronized Keychain scope. Do not add plaintext credential recovery copies. Legacy deletion evidence and cleanup remain governed by those services. Updating the same script reuses the existing scope; deleting and re-importing may create a new scope and require a replacement key.

Phone bindings, parcel state and timeline caches have their own existing persistence paths. Credential deletion is not business-data deletion. Do not infer permission to change storage, refresh providers or retention from a packaging or documentation change.

Home shows a dismissible Access Key notice only after a completed gateway response returns HTTP 401 with `unauthorized` for the current credential. A 2xx response with an accepted JSON object body, a successful credential save or removal clear it. Every timely, uncancelled, completed HTTP response advances the response-order fence, so an older reply cannot replace newer evidence; credential generations also reject replies from a replaced key. Other HTTP errors and rejected response bodies do not create or clear a notice, but prevent an older unauthorized reply from arriving afterward and creating one. Missing credentials, configuration conflicts and network failures do not create this notice. This observation is process-local: closing the banner lasts for the current Home UI session and creates no stored preference, extra request, retry or authorization restriction. Text, background and close symbol use semantic system colors for both appearances; actual Scripting-host layout and VoiceOver behavior still require device verification.
