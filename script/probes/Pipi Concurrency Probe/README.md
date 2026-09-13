# Pipi Concurrency Probe

This is a separate diagnostic script. It does not import Pipi Deliveries, access
credentials, request the network, or read/write delivery state. It uses only
synthetic files under App Group Documents / `pipi-deliveries-concurrency-probe-v1`.

## Run on the iPhone

1. Import `pipi-concurrency-probe.scripting` into Scripting as a separate script.
2. Run **Pipi Concurrency Probe** once in the app.
3. Add a small Scripting Home Screen widget and select **Pipi Concurrency Probe**.
   Repeat with a medium widget. Use actual Home Screen widgets, not app previews.
4. Reopen the script, then select **Read widget results**. Capture the app,
   widget-small and widget-medium result sections and their timestamps.

Each host should report `CHECKS PASSED`; their `Shared witness` values should
match. A missing widget section means that host has not supplied evidence yet.
`Stopped at` identifies the failing phase without logging native error text or
filesystem paths. The same report is printed as `pipi.atomic.probe` in the script
console. The app exits when its result page is dismissed. Widget work finishes
before presentation.

## Meaning of the checks

- Sync publication resolves to the original verified synthetic file.
- A duplicate sync creation fails and preserves that file and link.
- Eight asynchronous creations of one link yield exactly one successful call.
- An occupied ordinary file cannot be overwritten by link creation.
- Removing a link retains its target; the removed name can be reused.
- A retired parent directory rejects a late link creation without resurrection.
- All hosts observe the same permanent synthetic shared witness.

The async race has a three-second JavaScript waiting deadline. Host suspension can
delay JavaScript callbacks; the deadline is not a native execution guarantee.

These are native primitive and shared-visibility checks. They do not prove that
the app and widget ran simultaneously, that a refresh lease algorithm is correct,
or that full/detail commits are atomic. The current delivery package remains
unchanged. Replacing its writer requires additional contention, expiry, recovery,
and state-rebase tests through the owning implementation.

Each completed invocation removes its own temporary workspace. The fixed witness
and last report for each of three hosts remain for comparison. If iOS terminates
the script before cleanup, its synthetic workspace can remain in this diagnostic
directory; no business cleanup or cache deletion is performed.

## Local validation

From the repository root:

```sh
node --no-warnings --experimental-transform-types deliveries/script/probes/probe.test.mjs
```

This uses Node filesystem adapters, negative bridge fixtures, and three actual
local processes. It validates the diagnostic, not the Scripting iPhone bridge.

Confirmed official APIs:
[FileManager](https://scriptingapp.github.io/guide/Utilities/FileManager),
[Quick Start](https://scriptingapp.github.io/guide/Quick%20Start),
[Widget API](https://scriptingapp.github.io/guide/Widget/Widget%20API),
[Widget Quick Start](https://scriptingapp.github.io/guide/Widget/Widget%20Quick%20Start).
