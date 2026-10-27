# Scripting development and packaging

This guide is for maintainers. The installed package's [README](../script/README.md) is the user guide.

## Owning files

`script/project/` is the source of the Scripting app. `script/pipi-deliveries.scripting` is its generated ZIP package. Work in the canonical Pipi Assistant workspace's `deliveries/` directory; the independent `HotKids/pipi-deliveries` repository remains a distribution mirror, not another development checkout.

The package contains `script/README.md` as its root `README.md`, followed by the runtime entry points, shared modules, contracts and assets. Tests and tools stay outside the package. The verifier compares every packaged file with its owning source, checks required entries, and rejects unexpected files, disallowed material and network URLs. A README-only change still requires regenerating the package.

Current entry points are `index.tsx` (app), `widget.tsx` (Home Screen widgets), `intent.tsx` (Shortcuts) and `app_intents.tsx` (registered refresh intent). The native Scripting host is required; this is not an independent IPA.

## Source checks and packaging

Run these commands from the Deliveries directory (`deliveries/` in the canonical workspace):

```sh
sh script/project/tools/test.sh
sh script/project/tools/package.sh
sh script/project/tools/verify-package.sh script/pipi-deliveries.scripting formal source
```

The behavior suite uses Node.js 24 in CI and the repository's TypeScript loader. Packaging requires a POSIX shell, Python 3, `zip`, `unzip` and `rg`; missing `rg` is a hard verification failure. A Git work tree additionally requires Git: packaging and verification select indexed files and read their current working-tree contents, excluding untracked and ignored files. A downloaded source archive with no enclosing Git metadata uses the files in the same allowed runtime paths and does not require Git. Both modes exclude dot-path components and development files, and use `script/README.md` as the package README. A missing Git executable, unreadable index or invalid worktree metadata in a checkout remains a failure; it cannot switch that checkout to archive mode. The package tool writes a temporary archive, verifies it, then replaces the requested output. The default purpose is `source`, which permits an undeployed candidate but does not authorize distribution, a mirror push, a deployment or a Release.

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
