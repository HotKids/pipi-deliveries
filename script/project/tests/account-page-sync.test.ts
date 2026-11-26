import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { memory } from "./state-storage-mock";
import { accountStatus, clearPlatformLogin, platformAccountSubtitle, savePlatformLogin } from "../services/platform-accounts";

// Owner 2026-11-21 (Deliveries iOS): 更多数据源的「立即同步」also starts the cloud record pull, the Cainiao row shows
// 寄件同步中 once its recipients are committed (IOS-PARITY-11), and a saved 智能识别 configuration closes its page.

Object.assign(globalThis, { UUID: { string: randomUUID } });
const { emptyState, saveState } = await import("../services/storage");
const { refreshPlatformParcels } = await import("../services/platform-parcel-sync");

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(projectRoot, path), "utf8");
const managerSource = read("pages/PhoneManagerPage.tsx");
const recognitionSource = read("pages/RecognitionSettingsPage.tsx");
const settingsSource = read("pages/SettingsPage.tsx");
const appSource = read("index.tsx");

const cainiaoCookie = {
  name: "cookie2", value: "synthetic-account-page-sync", domain: ".taobao.com",
  path: "/", isSecure: true, isHTTPOnly: true, isSessionOnly: true,
};
const md5Crypto = (original: typeof globalThis.Crypto) => ({ ...original,
  md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
});
const wrap = (data: object) => new Response(JSON.stringify({ ret: ["SUCCESS"], data: { data } }));

function progressLog() {
  const events: string[] = [];
  const record = (platform: string, running: boolean, stage?: string) => {
    events.push(`${platform}:${running}${stage ? `:${stage}` : ""}`);
  };
  return { events, record };
}

async function withCainiaoLogin(
  respond: (api: string) => Response | Promise<Response>,
  body: () => Promise<void>,
) {
  memory.clear();
  saveState(emptyState());
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cainiaoCookie] }, "synthetic-account-page-owner", "示例昵称");
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.Crypto;
  Object.assign(globalThis, { Crypto: md5Crypto(originalCrypto) });
  globalThis.fetch = (async (url: string) => {
    const api = new URL(String(url)).searchParams.get("api") || "";
    return respond(api);
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(globalThis, { Crypto: originalCrypto });
    clearPlatformLogin("cainiao", accountStatus("cainiao").generation);
  }
}

test("Cainiao reports its sender stage after committing recipients, before the sender request", async () => {
  const progress = progressLog();
  const observedAtSender: string[] = [];
  let senderRequests = 0;
  await withCainiaoLogin((api) => {
    if (api.endsWith("queryPdsPackageDataList")) return wrap({ packages: [] });
    senderRequests++;
    observedAtSender.push([...progress.events].join(","), platformAccountSubtitle(accountStatus("cainiao")));
    return wrap({ orderBriefList: [] });
  }, async () => {
    const result = await refreshPlatformParcels(() => {}, "manual", "cainiao", progress.record);
    assert.ok(senderRequests > 0);
    assert.equal(observedAtSender[0], "cainiao:true,cainiao:true:sender", "the sender stage precedes the sender request");
    assert.match(observedAtSender[1], /^示例昵称 · \d\d:\d\d$/,
      "the recipient sync time is published before sender appointments load");
    assert.deepEqual(result.issues, []);
    assert.deepEqual(progress.events, ["cainiao:true", "cainiao:true:sender", "cainiao:false"]);
  });
});

test("a failed Cainiao recipient read keeps the row syncing without a sender stage", async () => {
  const progress = progressLog();
  await withCainiaoLogin((api) => {
    if (api.endsWith("queryPdsPackageDataList")) return new Response(JSON.stringify({ ret: ["FAIL_SYS_REQUEST_REJECTED"] }));
    return wrap({ orderBriefList: [] });
  }, async () => {
    const result = await refreshPlatformParcels(() => {}, "manual", "cainiao", progress.record);
    assert.deepEqual(result.issues, [{ platform: "cainiao", reason: "partial" }]);
    assert.deepEqual(progress.events, ["cainiao:true", "cainiao:false"]);
  });
});

test("a caller that joins a Cainiao round in its sender stage reports that stage at once", async () => {
  const first = progressLog();
  const joined = progressLog();
  let releaseSender!: () => void;
  const senderGate = new Promise<void>(resolve => { releaseSender = resolve; });
  let senderStarted!: () => void;
  const senderReached = new Promise<void>(resolve => { senderStarted = resolve; });
  await withCainiaoLogin(async (api) => {
    if (api.endsWith("queryPdsPackageDataList")) return wrap({ packages: [] });
    senderStarted();
    await senderGate;
    return wrap({ orderBriefList: [] });
  }, async () => {
    const running = refreshPlatformParcels(() => {}, "manual", "cainiao", first.record);
    await senderReached;
    const joining = refreshPlatformParcels(() => {}, "manual", "cainiao", joined.record);
    assert.deepEqual(joined.events, ["cainiao:true", "cainiao:true:sender"]);
    releaseSender();
    await Promise.all([running, joining]);
    assert.deepEqual(first.events, ["cainiao:true", "cainiao:true:sender", "cainiao:false"]);
    assert.deepEqual(joined.events, ["cainiao:true", "cainiao:true:sender", "cainiao:false"]);
  });
});

// Execute the page's real handlers; only the host view tree and hooks are substituted.
function mountHandlers(source: string, name: string, props: unknown, exports: string, globals: object) {
  const hookValues: unknown[] = [];
  const effectCleanups: Array<(() => void) | undefined> = [];
  const effectDeps: unknown[][] = [];
  let index = 0;
  let pendingEffects: Array<() => void> = [];
  const page = runInNewContext(stripTypeScriptTypes(
    `${source.replace("export function", "function")}\nreturn { ${exports} };\n}\n${name}`,
    { mode: "transform" },
  ), {
    useState(initial: unknown) {
      const at = index++;
      if (!(at in hookValues)) hookValues[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hookValues[at], (value: unknown) => {
        hookValues[at] = typeof value === "function" ? (value as (previous: unknown) => unknown)(hookValues[at]) : value;
      }];
    },
    useRef(initial: unknown) {
      const at = index++;
      return (hookValues[at] ??= { current: initial });
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const at = index++;
      if (!effectDeps[at] || deps.some((value, item) => value !== effectDeps[at][item])) {
        pendingEffects.push(() => {
          effectCleanups[at]?.();
          effectCleanups[at] = effect();
          effectDeps[at] = deps;
        });
      }
    },
    ...globals,
  });
  return {
    render() {
      index = 0;
      pendingEffects = [];
      const value = page(props);
      for (const effect of pendingEffects) effect();
      return value;
    },
    unmount() { for (const cleanup of effectCleanups) cleanup?.(); },
  };
}

const managerHandlers = managerSource.slice(
  managerSource.indexOf("export function PhoneManagerPage("),
  managerSource.indexOf("  return (\n    <List"),
);
const managerExports = "setVisible, syncNow, syncingPlatforms, sendingPlatforms, cloudSyncAvailable, notice, busy";

function manager(options: { cloud: boolean; activeCainiao: boolean; cloudRefresh?: () => Promise<void> }) {
  const timers: Array<() => void> = [];
  const platformCalls: Array<{ platform: string | undefined; progress: (...args: any[]) => void; finish: (value: string) => void }> = [];
  let cloudCalls = 0;
  const props = {
    bindings: [], stateRevision: 1, busy: false,
    onPlatformRefresh: (platform: string | undefined, progress: (...args: any[]) => void) =>
      new Promise<string>(finish => { platformCalls.push({ platform, progress, finish }); }),
    onCloudRecordsRefresh: options.cloudRefresh ? () => { cloudCalls++; return options.cloudRefresh!(); } : undefined,
  };
  const mounted = mountHandlers(managerHandlers, "PhoneManagerPage", props, managerExports, {
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    SCRIPT_BINDING_SOURCE: "interface5",
    PLATFORM_SOURCES: ["cainiao", "pinduoduo", "jingdong", "fengchao"],
    accountStatus: (platform: string) => ({ generation: platform, label: "", syncedAtMs: 0,
      state: platform === "cainiao" && options.activeCainiao ? "active" : "offline" }),
    onPlatformAccountsChanged: () => () => {},
    cloudRecordsAvailable: () => options.cloud,
    existingEnhancementIdentity: () => null,
    EnhancementIdentityMissing: class { message = "missing"; },
    EXPRESS_TOAST_COPY: { refreshFailed: "刷新失败" },
    errorMessage: (_error: unknown, fallback: string) => fallback,
    writeDiagnostic: () => {},
  });
  mounted.render().setVisible(true);
  mounted.render();
  while (timers.length) timers.shift()!();
  return { mounted, platformCalls, cloudCalls: () => cloudCalls };
}

test("立即同步 starts the cloud record pull with the platform sync and frees the page after the platforms", async () => {
  let finishCloud!: () => void;
  const page = manager({ cloud: true, activeCainiao: true,
    cloudRefresh: () => new Promise<void>(resolve => { finishCloud = resolve; }) });
  assert.equal(page.mounted.render().cloudSyncAvailable, true);
  const sync = page.mounted.render().syncNow();
  assert.equal(page.platformCalls.length, 1);
  assert.equal(page.platformCalls[0].platform, undefined, "all logged-in platforms sync");
  assert.equal(page.cloudCalls(), 1, "the cloud pull starts with the platform sync");
  await page.mounted.render().syncNow();
  assert.equal(page.cloudCalls(), 1, "a second tap while syncing starts nothing");

  const [{ progress, finish }] = page.platformCalls;
  progress("cainiao", true);
  assert.deepEqual(Array.from(page.mounted.render().syncingPlatforms), ["cainiao"]);
  progress("cainiao", true, "sender");
  assert.deepEqual(Array.from(page.mounted.render().syncingPlatforms), [],
    "the Cainiao icon returns once its recipients commit");
  assert.deepEqual(Array.from(page.mounted.render().sendingPlatforms), ["cainiao"], "the row reads 寄件同步中");
  progress("cainiao", false);
  assert.deepEqual(Array.from(page.mounted.render().sendingPlatforms), []);
  assert.equal(page.mounted.render().busy, true, "the page is busy while the platforms sync");
  finish("同步完成");
  await sync;
  assert.equal(page.mounted.render().busy, false,
    "the page is free once the platforms finish, while the app-level cloud pull continues");
  assert.equal(page.mounted.render().notice, "同步完成", "the platform summary keeps its own toast");
  finishCloud();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.mounted.render().notice, "同步完成", "the cloud pull adds no toast");
  page.mounted.unmount();
});

test("an authorized Access Key alone enables a silent cloud pull that does not hold the page", async () => {
  const page = manager({ cloud: true, activeCainiao: false, cloudRefresh: () => new Promise<void>(() => {}) });
  await page.mounted.render().syncNow();
  assert.equal(page.platformCalls.length, 0, "no platform account is synced");
  assert.equal(page.cloudCalls(), 1);
  assert.equal(page.mounted.render().busy, false, "the unfinished cloud pull leaves the page free");
  assert.equal(page.mounted.render().notice, "");
  page.mounted.unmount();
});

test("a failed cloud pull shows no error", async () => {
  const page = manager({ cloud: true, activeCainiao: false, cloudRefresh: () => Promise.reject(new Error("synthetic")) });
  await page.mounted.render().syncNow();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.cloudCalls(), 1);
  assert.equal(page.mounted.render().notice, "");
  page.mounted.unmount();
});

test("without an authorized Access Key the cloud pull is skipped without a message", async () => {
  const page = manager({ cloud: false, activeCainiao: true, cloudRefresh: async () => {} });
  assert.equal(page.mounted.render().cloudSyncAvailable, false);
  const sync = page.mounted.render().syncNow();
  assert.equal(page.cloudCalls(), 0);
  assert.equal(page.platformCalls.length, 1);
  page.platformCalls[0].finish("同步完成");
  await sync;
  assert.equal(page.mounted.render().notice, "同步完成");
  page.mounted.unmount();

  const idle = manager({ cloud: false, activeCainiao: false, cloudRefresh: async () => {} });
  await idle.mounted.render().syncNow();
  assert.equal(idle.cloudCalls(), 0);
  assert.equal(idle.platformCalls.length, 0);
  assert.equal(idle.mounted.render().notice, "");
  idle.mounted.unmount();
});

test("the account page wires 立即同步, the row status and the shared cloud owner", () => {
  assert.match(managerSource,
    /title="立即同步"[^>]*disabled=\{busy \|\| !cloudSyncAvailable &&\s*!Object\.values\(platformAccounts\)\.some\(\(item\) => item\?\.state === "active"\)\}\s*action=\{\(\) => void syncNow\(\)\}/,
    "the button is available for a logged-in platform or an authorized Access Key");
  assert.match(managerSource, /sending=\{sendingPlatforms\.includes\(platform\)\}/);
  assert.match(managerSource, /\{sending \? SENDER_SYNCING : copy\.status\}/);
  assert.match(managerSource, /const SENDER_SYNCING = "寄件同步中";/);
  assert.match(managerSource, /Boolean\(mealCredentialScope\(\) \|\| activeWatchScope\(\)\)/);
  assert.match(settingsSource, /<PhoneManagerPage[\s\S]*?onCloudRecordsRefresh=\{props\.onCloudRecordsRefresh\}/);
  assert.match(appSource, /<SettingsPage [\s\S]*?onCloudRecordsRefresh=\{\(\) => refreshCloudRecords\("sync_now"\)\}/);
  // The list pull starts the same cloud owner and hands its Watch read back to the page (G-HIGH-10).
  assert.match(appSource, /onListPull=\{\(\) => \{ refreshPlatformList\("pull"\); return startCloudRecords\("list_pull"\)\.international; \}\}/);
  assert.match(appSource, /function refreshCloudRecords\(trigger: "list_pull" \| "access_key" \| "sync_now"\): Promise<void> \{\s*return startCloudRecords\(trigger\)\.done;/);
  assert.match(appSource, /onAccessKeyChanged=\{\(\) => \{\s*setWatchAccessRevision\(value => value \+ 1\);\s*void refreshCloudRecords\("access_key"\);/);
  // The cloud PDD list has one owner in sync.ts, shared by a full refresh and this pull (owner 2026-11-21: 加上（推荐）).
  assert.match(appSource, /import \{ refreshAllShipments, refreshCloudPddParcels, subscribeRefreshState \} from "\.\/services\/sync";/);
});

test("the shared cloud owner pulls meal codes and international parcels and never rejects", async () => {
  const owners = stripTypeScriptTypes(appSource.slice(
    appSource.indexOf("  function refreshInternational("), appSource.indexOf("  async function finishPickup("),
  ), { mode: "transform" });
  const calls: string[] = [];
  let mealScope = "synthetic-scope";
  let watchFails = false;
  let mealFails = false;
  const observed = { revision: 1, shipments: [] };
  const latestPickupView = { current: { state: observed as unknown, pickupCards: [] } };
  const scope = {
    Date,
    internationalRequest: { current: { startedAt: Date.now(), generation: 0 } },
    revision: { current: 1 },
    latestPickupView,
    readMealCards: () => { calls.push("meal-cards"); return []; },
    setMealCards: () => {},
    // Both real owners return without a request when no Access Key scope is authorized.
    ensureMealRules: async (trigger: string, request: { explicit?: boolean }) => {
      calls.push(`meal-rules:${trigger}:${request?.explicit ? "explicit" : "automatic"}`);
      return mealScope ? {} : null;
    },
    // The real owner reads nothing without a saved key, off the formal track or out of the foreground.
    refreshCloudPddParcels: async (state: unknown, publish: unknown) => {
      assert.equal(state, latestPickupView.current.state, "the read starts from the state on screen");
      assert.equal(publish, scope.applyState);
      calls.push("pdd");
    },
    synchronizeMeals: async () => {
      if (!mealScope) return;
      calls.push("meal-sync");
      if (mealFails) throw new Error("synthetic");
    },
    refreshStoredWatchShipments: async () => {
      calls.push("watch");
      if (watchFails) throw new Error("synthetic");
      return { revision: 2 };
    },
    applyState: () => { calls.push("apply"); },
    writeDiagnostic: (event: string, details?: { domain?: string }) => {
      calls.push(details?.domain ? `${event}:${details.domain}` : event);
    },
    diagnosticErrorDetails: () => ({}),
  };
  const refreshCloudRecords = Function("scope", `with (scope) { ${owners}; return refreshCloudRecords; }`)(scope);

  await refreshCloudRecords("sync_now");
  assert.ok(calls.includes("meal-sync"), "an authorized meal scope pulls cloud meal_pickup records");
  assert.ok(calls.includes("watch"), "the international pull runs inside the two-minute window");
  assert.ok(calls.includes("apply"));
  assert.ok(calls.includes("pdd"), "立即同步 reads the cloud PDD list once");
  assert.equal(calls.filter(call => call === "pdd").length, 1);
  assert.ok(calls.includes("meal-rules:meal_sync:explicit"), "立即同步 is not held by the automatic rules backoff");

  calls.length = 0;
  await refreshCloudRecords("access_key");
  assert.ok(calls.includes("pdd"), "a key change reads the new key's cloud PDD list");
  assert.ok(calls.includes("meal-rules:meal_sync:explicit"));

  calls.length = 0;
  await refreshCloudRecords("list_pull");
  assert.ok(!calls.includes("pdd"), "the list pull's own refresh already read the cloud PDD list in this pass");
  assert.ok(calls.includes("meal-rules:meal_sync:automatic"), "a list pull is an automatic meal pull");

  calls.length = 0;
  latestPickupView.current.state = null;
  await refreshCloudRecords("sync_now");
  assert.ok(!calls.includes("pdd"), "without loaded state there is nothing to merge into");
  latestPickupView.current.state = observed;

  calls.length = 0;
  mealScope = "";
  await refreshCloudRecords("sync_now");
  assert.ok(!calls.includes("meal-sync"), "without an authorized meal scope no cloud meal request is made");
  // Not pinned here: with an authorized scope, refreshMeals still skips synchronizeMeals while ensureMealRules
  // returns null because no rule pack has been accepted yet (the next pull asks again, owner 2026-11-21).
  // Whether the meal pull may run without a rule pack is an open owner decision.

  calls.length = 0;
  mealScope = "synthetic-scope";
  mealFails = true;
  watchFails = true;
  await refreshCloudRecords("sync_now");
  assert.ok(calls.includes("meal.cards.refresh.failed"));
  // D188: the Watch failure is a cloud.sync line of the international domain.
  assert.ok(calls.includes("cloud.sync.failed:international"));
});

const recognitionHandlers = recognitionSource.slice(
  recognitionSource.indexOf("const CONNECTION_TESTING ="), recognitionSource.indexOf("\nfunction ProviderLogo"),
) + recognitionSource.slice(
  recognitionSource.indexOf("export function RecognitionSettingsPage("),
  recognitionSource.indexOf("  function field("),
);

class SyntheticSettingError extends Error {
  constructor(readonly field: string) { super(field); }
}

function recognitionPage(saveOutcome: "saved" | "invalid" | "storage" | "unreadable") {
  const saved: string[] = [];
  let writes = 0;
  const page = mountHandlers(recognitionHandlers, "RecognitionSettingsPage", { onSaved: (message: string) => saved.push(message) },
    "save, notice, validation", {
      recognitionSettings: () => ({ draft: { mode: "local", provider: "openai", providerName: "", baseUrl: "", model: "" },
        keyLength: 0, valid: true }),
      saveRecognitionSettings: () => {
        writes++;
        if (saveOutcome === "invalid") throw new SyntheticSettingError("model");
        if (saveOutcome === "storage") throw new SyntheticSettingError("storage");
        if (saveOutcome === "unreadable") throw new Error("synthetic");
      },
      RecognitionSettingError: SyntheticSettingError,
      SAVE_FAILED_TOAST: "保存失败，请稍后重试",
      PROVIDER_NAMES: { gemini: "Gemini", openai: "OpenAI", compatible: "OpenAI-Compat" },
    });
  return { page, saved, writes: () => writes };
}

test("a saved recognition configuration closes the page with the Pipi copy", () => {
  const { page, saved, writes } = recognitionPage("saved");
  page.render().save();
  assert.equal(writes(), 1);
  assert.deepEqual(saved, ["识别设置已保存"]);
  assert.equal(page.render().notice, "", "the message is shown on the page it returns to");
  page.unmount();
});

for (const outcome of ["invalid", "storage", "unreadable"] as const) {
  test(`a failed recognition save (${outcome}) stays on the page with its existing error`, () => {
    const { page, saved } = recognitionPage(outcome);
    page.render().save();
    assert.deepEqual(saved, []);
    const { notice, validation } = page.render();
    if (outcome === "invalid") {
      assert.equal(validation?.field, "model");
      assert.equal(notice, "");
    } else {
      assert.equal(validation, undefined);
      assert.equal(notice, "保存失败，请稍后重试");
    }
    page.unmount();
  });
}

test("the recognition page keeps its checkmark and Settings closes it after a save", () => {
  assert.match(recognitionSource, /<Button title="保存" systemImage="checkmark" labelStyle="iconOnly"\s+action=\{save\}/);
  assert.match(settingsSource,
    /<RecognitionSettingsPage onSaved=\{\(message\) => \{[\s\S]*?setDestination\(""\);\s*setNotice\(message\);\s*\}\} \/>/);
});
