import assert from "node:assert/strict";
import { register } from "node:module";

// 用户 2026-09-27：以后安装 beta 版就默认重新打开，安装正式版就跟随之前的设置（iOS 同 Pipi）。
// Importing a beta package whose SCRIPT_VERSION differs from the recorded one turns the diagnostic
// log back on and records that version; within the same beta a manual "off" holds, across every host
// (app, widget, App Intent) because the switch and the record share storage. Formal builds keep the
// stored switch, and a switch that was never set stays at the formal default (off).

const ENABLED_KEY = "pipi_deliveries_diagnostic_enabled_v1";
const BETA_VERSION_KEY = "pipi_deliveries_diagnostic_beta_version_v1";

const memory = new Map<string, unknown>();
let failReads = false;
let failWrites = false;
const writtenKeys: string[] = [];
Object.assign(globalThis, {
  Storage: {
    get<T>(key: string, options?: { shared?: boolean }): T | null {
      assert.equal(options?.shared, true, `${key} must live in shared storage`);
      if (failReads) throw new Error("synthetic storage failure");
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown, options?: { shared?: boolean }): boolean {
      assert.equal(options?.shared, true, `${key} must live in shared storage`);
      if (failWrites) throw new Error("synthetic storage failure");
      writtenKeys.push(key);
      memory.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      memory.delete(key);
    },
  },
});

// Each import below is a fresh logger instance — one host runtime (app launch, widget run, App
// Intent) — built against the track and version named in its URL, independent of the checked-in
// build-track.ts.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  const build = context.parentURL ? new URL(context.parentURL).searchParams.get("build") : null;
  if (build && (specifier === "./build-track" || specifier === "./build-track.ts")) {
    const [track, version] = JSON.parse(build);
    const source = "export const SCRIPT_BUILD_TRACK = " + JSON.stringify(track) + ";" +
      "export const SCRIPT_VERSION = " + JSON.stringify(version) + ";" +
      "export const SCRIPT_CLIENT_BUILD = 1;" +
      "export const GATEWAY_ORIGIN = \\"https://example.invalid\\";";
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
  }
  return nextResolve(specifier, context);
}
`)}`);

type Logger = typeof import("../services/logger");
let runtimeCount = 0;
async function launch(track: "beta" | "formal", version: string): Promise<Logger> {
  runtimeCount++;
  const build = encodeURIComponent(JSON.stringify([track, version]));
  return await import(`../services/logger.ts?build=${build}&runtime=${runtimeCount}`) as Logger;
}

function reset(entries: Record<string, unknown> = {}): void {
  memory.clear();
  writtenKeys.length = 0;
  for (const [key, value] of Object.entries(entries)) memory.set(key, value);
}

// A new beta reopens the log the user turned off in an earlier beta, and records its version.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.4-beta9" });
{
  const logger = await launch("beta", "0.6.5-beta1");
  assert.equal(logger.diagnosticsEnabled(), true, "a newly imported beta turns recording back on");
  assert.equal(memory.get(ENABLED_KEY), true);
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta1", "the reopening beta records its version");
}

// The first beta carrying this rule reopens a log turned off before it (no record yet).
reset({ [ENABLED_KEY]: false });
{
  const logger = await launch("beta", "0.6.5-beta1");
  assert.equal(logger.diagnosticsEnabled(), true);
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta1");
}

// The hot path reopens too: the first line written by a new beta is recorded, not dropped.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.4-beta9" });
{
  const logger = await launch("beta", "0.6.5-beta2");
  logger.writeDiagnostic("widget.run.started", { flowId: "beta-install" });
  assert.equal(logger.readDiagnostics().length, 1, "the first write of a new beta is recorded");
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta2");
}

// Within the same beta the user's "off" holds: in this runtime, and in every later runtime or host.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.4-beta9" });
{
  const app = await launch("beta", "0.6.5-beta1");
  assert.equal(app.diagnosticsEnabled(), true);
  assert.equal(app.setDiagnosticsEnabled(false), true);
  assert.equal(app.diagnosticsEnabled(), false, "a manual off within this beta holds in this runtime");
  const widget = await launch("beta", "0.6.5-beta1");
  assert.equal(widget.diagnosticsEnabled(), false, "the same beta in another host keeps the user's off");
  widget.writeDiagnostic("widget.run.started", { flowId: "beta-install" });
  assert.equal(widget.readDiagnostics().length, 0, "nothing is recorded while the user keeps it off");
  const relaunch = await launch("beta", "0.6.5-beta1");
  assert.equal(relaunch.diagnosticsEnabled(), false, "relaunching the same beta keeps the user's off");
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta1");
}

// Same beta, switch stored off by the user, record already current: nothing changes, nothing written.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.5-beta1" });
{
  const logger = await launch("beta", "0.6.5-beta1");
  assert.equal(logger.diagnosticsEnabled(), false, "an unchanged beta version leaves the switch alone");
  assert.deepEqual(writtenKeys, []);
}

// A manual off made as the very first touch of a new beta still holds afterwards.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.4-beta9" });
{
  const logger = await launch("beta", "0.6.5-beta1");
  assert.equal(logger.setDiagnosticsEnabled(false), true);
  assert.equal(logger.diagnosticsEnabled(), false, "the user's off is not overridden by the reopen");
  const next = await launch("beta", "0.6.5-beta1");
  assert.equal(next.diagnosticsEnabled(), false);
}

// A later beta reopens again after the user turned it off in the previous one.
{
  const logger = await launch("beta", "0.6.5-beta2");
  assert.equal(logger.diagnosticsEnabled(), true, "every new beta reopens once");
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta2");
}

// Formal keeps whatever was stored before, and writes neither the switch nor the record.
for (const stored of [false, true]) {
  reset({ [ENABLED_KEY]: stored, [BETA_VERSION_KEY]: "0.6.5-beta1" });
  const logger = await launch("formal", "0.6.5");
  assert.equal(logger.diagnosticsEnabled(), stored, "formal follows the previous setting");
  logger.writeDiagnostic("widget.run.started", { flowId: "formal-install" });
  assert.equal(memory.get(ENABLED_KEY), stored);
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta1", "formal never touches the beta record");
  assert.equal(writtenKeys.includes(ENABLED_KEY), false);
  assert.equal(writtenKeys.includes(BETA_VERSION_KEY), false);
}

// Formal with a switch that was never set stays at the formal default: off.
reset();
{
  const logger = await launch("formal", "0.6.5");
  assert.equal(logger.diagnosticsEnabled(), false, "formal defaults to off");
  logger.writeDiagnostic("widget.run.started", { flowId: "formal-install" });
  assert.equal(logger.readDiagnostics().length, 0);
  assert.equal(memory.has(ENABLED_KEY), false);
  assert.equal(memory.has(BETA_VERSION_KEY), false);
}

// Storage failures never throw into business code; the switch falls back as before.
reset({ [ENABLED_KEY]: false, [BETA_VERSION_KEY]: "0.6.4-beta9" });
failReads = true;
try {
  const logger = await launch("beta", "0.6.5-beta1");
  assert.doesNotThrow(() => logger.diagnosticsEnabled());
  assert.equal(logger.diagnosticsEnabled(), true, "an unreadable switch falls back to the beta default");
  assert.doesNotThrow(() => logger.writeDiagnostic("widget.run.started", { flowId: "beta-install" }));
} finally {
  failReads = false;
}
failWrites = true;
try {
  const logger = await launch("beta", "0.6.5-beta1");
  assert.doesNotThrow(() => logger.diagnosticsEnabled());
  assert.equal(logger.diagnosticsEnabled(), false, "an unwritable store keeps the stored switch");
  assert.equal(logger.setDiagnosticsEnabled(true), false);
} finally {
  failWrites = false;
}
assert.equal(memory.get(BETA_VERSION_KEY), "0.6.4-beta9",
  "a failed reopen is not recorded, so the next runtime tries again");
{
  const logger = await launch("beta", "0.6.5-beta1");
  assert.equal(logger.diagnosticsEnabled(), true, "the next runtime reopens once storage works");
  assert.equal(memory.get(BETA_VERSION_KEY), "0.6.5-beta1");
}

console.log("diagnostic beta install tests passed");
