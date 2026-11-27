import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { memory } from "./state-storage-mock.ts";

const NOW = Date.UTC(2026, 10, 26, 7, 0, 0);
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => {
  Date.now = realNow;
});

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value, "utf8").digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
let widgetReloadCount = 0;
const scheduledNotifications: Array<{ title: string; body: string }> = [];
Object.assign(globalThis, {
  UUID: { string: () => randomUUID() },
  Notification: {
    schedule: async (req: { title: string; body: string }) => {
      scheduledNotifications.push({ title: req.title, body: req.body });
      return true;
    },
  },
  Widget: { reloadAll() { widgetReloadCount++; } },
  Device: {
    systemVersion: "26.0",
    isiPhone: true,
    screen: { width: 402, height: 874, scale: 3 },
    safeAreaInsets: { top: 59, bottom: 34, leading: 0, trailing: 0 },
  },
  Script: { directory: "/synthetic", name: "Pipi Deliveries", createRunSingleURLScheme: () => "scripting://pipi" },
});

const { saveGatewayToken } = await import("../services/credentials.ts");
const { EXPRESS_TOAST_COPY } = await import("../services/express-toast-copy.ts");
const { errorMessage } = await import("../services/ui-feedback.ts");
const { readCloudPddParcels } = await import("../services/pdd-cloud-records.ts");
const {
  resetParcelCloudDeniedBackoffForTests,
  synchronizeParcelCloudRecords,
} = await import("../services/parcel-cloud-sync.ts");
const { enrichPendingCloudShipments } = await import("../services/sync.ts");
const {
  commitWatchSnapshot,
  emptyState,
  loadState,
  refreshStoredWatchShipments,
  removeShipment,
  savePlatformParcelData,
  saveState,
  visibleShipments,
} = await import("../services/storage.ts");
const { activeWatchScope, internationalShipmentSnapshot } = await import("../services/international-records.ts");
const { absorbManualShipment, selectShipmentTimeline } = await import("../services/shipment-policy.ts");
const { attachedShipmentIds, withWaybillOwnership } = await import("../services/waybill-ownership.ts");
const { applyAccountOrderProjectionToOwner } = await import("../services/sync/jd-order-projection.ts");
const { createSyncRuntimeState } = await import("../services/sync/shared.ts");
const { withH5Controller } = await import("../services/sync/h5-capture.ts");
const { resolveCarrierKuaidi100Code, resolveCarrierName, resolveCarrierQuery } =
  await import("../services/carrier-query.ts");
const { carrierDisplayName, courierIconName } = await import("../services/carrier-presentation.ts");
const { jdDiagnosticPage } = await import("../services/logger.ts");
const { jdLoginProof, PlatformWireError } = await import("../services/platform-wire.ts");
const { accountStatus, clearPlatformLogin, platformSession, savePlatformLogin } =
  await import("../services/platform-accounts.ts");
const { fetchJdParcels, fetchPddOrders } = await import("../services/platform-web-parcels.ts");
const { pddParcelAppURL } = await import("../services/platform-parcel-data.ts");
const { registerProjectionViewportHost, setProjectionSceneActive } =
  await import("../services/projection-viewport.ts");

test("LIVE BUG 6 & I-2: LiveActivity.register & AppIntentManager.register are idempotent singletons and extension entry paths use static imports", () => {
  const widgetSource = readFileSync(new URL("../widget.tsx", import.meta.url), "utf8");
  const appIntentsSource = readFileSync(new URL("../app_intents.tsx", import.meta.url), "utf8");
  const liveActivitySource = readFileSync(new URL("../live_activity.tsx", import.meta.url), "utf8");
  const parcelLiveActivitySource = readFileSync(new URL("../services/parcel-live-activity.ts", import.meta.url), "utf8");

  // 1. I-2: Extension entry paths must NEVER depend on dynamic `await import(...)`
  for (const [label, src] of [
    ["widget.tsx", widgetSource],
    ["app_intents.tsx", appIntentsSource],
    ["services/parcel-live-activity.ts", parcelLiveActivitySource],
  ] as const) {
    assert.doesNotMatch(src, /\bimport\s*\(/, `${label} must use static imports rather than dynamic import(...)`);
  }
  assert.match(liveActivitySource, /__pipiDeliveriesParcelPickupBuilder__/, "live_activity.tsx guards duplicate registration via globalThis");

  // 2. Simulate warm WidgetKit JSContext evaluating app_intents.tsx + live_activity.tsx TWICE (entry + module import)
  const registeredActivities = new Set<string>();
  const registeredIntents = new Set<string>();
  const vmContext: Record<string, unknown> = {
    LiveActivity: {
      register: (name: string, builder: unknown) => {
        if (registeredActivities.has(name)) {
          throw new Error(`Registering the same builder name repeatedly is not allowed, "${name}".`);
        }
        registeredActivities.add(name);
        return () => ({ activityName: name, builder });
      },
    },
    AppIntentProtocol: { AppIntent: 0, LiveActivityIntent: 3 },
    AppIntentManager: {
      register: (spec: { name: string }) => {
        if (registeredIntents.has(spec.name)) {
          throw new Error(`Registering the same intent name repeatedly is not allowed, "${spec.name}".`);
        }
        registeredIntents.add(spec.name);
        return spec;
      },
    },
    PARCEL_ACTIVITY_NAME: "PipiDeliveriesParcelPickup",
    PARCEL_ACTIVITY_ART: "parcel-activity-art",
    PIPI_CARD: { capsuleHeight: 35, edge: 14 },
    writeRuntimeCapabilities() {},
    diagnosticErrorDetails: () => ({}),
    writeDiagnostic() {},
    flushDiagnostics() {},
  };
  vmContext.globalThis = vmContext;

  const stripModule = (src: string) =>
    stripTypeScriptTypes(
      src
        .replace(/\(data\)\s*=>\s*\{[\s\S]*?\n    \},/, "(data) => ({ data, intent: CompleteParcelActivityIntent }),")
        .replace(/\.tsx\b/g, ".ts"),
      { mode: "transform" },
    )
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export\s+\{[^}]*\};?\n/gm, "")
      .replace(/^export /gm, "");

  const compiledIntents = stripModule(appIntentsSource);
  const compiledLiveActivity = stripModule(liveActivitySource);

  // Evaluate both modules repeatedly in the same JSContext (simulating entry script + transitive import + warm render)
  runInNewContext(compiledIntents, vmContext);
  runInNewContext(compiledLiveActivity, vmContext);
  runInNewContext(`{ ${compiledIntents}\n${compiledLiveActivity} }`, vmContext);
  runInNewContext(`{ ${compiledLiveActivity} }`, vmContext);

  assert.deepEqual([...registeredActivities], ["PipiDeliveriesParcelPickup"]);
  assert.deepEqual([...registeredIntents].sort(), ["CompleteParcelActivityIntent", "RefreshPipiDeliveriesIntent"]);
});

test("LIVE BUG 3, IOS-SEP-03, U9, U10 & IOS-SR-07: List row separators, fixed TabView/FAB, RootPageHeader, and RecognitionSettingsPage", () => {
  for (const rel of [
    "../components/ShipmentRow.tsx",
    "../pages/HomePage.tsx",
    "../pages/SettingsPage.tsx",
    "../pages/PhoneManagerPage.tsx",
    "../pages/SamsungAssistantPage.tsx",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(src, /showSeparator|<Divider padding=\{\{ leading:/, `${rel} must use native List separators`);
  }

  const shortcutPageSrc = readFileSync(new URL("../pages/PickupSettingsPages.tsx", import.meta.url), "utf8");
  assert.equal((shortcutPageSrc.match(/footer=\{\s*<Text font="footnote"/g) ?? []).length, 2, "both Shortcut sections place footnotes in Section footer");

  const indexSrc = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(indexSrc, /tabBarMinimizeBehavior/, "U9: bottom TabView stays fixed without shrinking on scroll");
  assert.match(indexSrc, /background=\{ROOT_PAGE_BG\} ignoresSafeArea/, "U8: full-bleed ignoresSafeArea background behind TabView");
  const fabSrc = readFileSync(new URL("../components/TabFloatingActionButton.tsx", import.meta.url), "utf8");
  assert.match(fabSrc, /export const TAB_FAB_DIAMETER = 58;/, "U8: FAB diameter matches 58pt RoundButton spec");
  assert.match(fabSrc, /export const TAB_FAB_SCROLL_INSET = 104;/, "U8: list bottom scroll inset clears 58pt FAB");
  assert.doesNotMatch(fabSrc, /alignFabWithTabBar|ignoresSafeArea/, "U8: FAB stays inside safe area without dropping beside TabBar");

  const rootHeaderSrc = readFileSync(new URL("../components/RootPageHeader.tsx", import.meta.url), "utf8");
  assert.match(rootHeaderSrc, /toolbarVisibility=\{\{ visibility: "hidden", bars: \["navigationBar"\] \}\}/, "U8: List hides navigationBar cleanly");
  assert.match(rootHeaderSrc, /<BigTitle title=\{title\} onClose=\{onClose\}[\s\S]*?<\/VStack>\s*<List[\s\S]*?>\s*\{children\}\s*<\/List>/, "U8: BigTitle header stays fixed above scrolling List without divider");

  const pickupPageSrc = readFileSync(new URL("../pages/PickupPage.tsx", import.meta.url), "utf8");
  assert.match(pickupPageSrc, /popover:\s*\{[\s\S]*?arrowEdge:\s*"bottom"[\s\S]*?presentationCompactAdaptation:\s*"popover"/, "U8: IdentityCodeButton uses popover");
  assert.match(pickupPageSrc, /fixedSize=\{\{ horizontal: true, vertical: true \}\}/, "U8: tight popover width");
  assert.match(pickupPageSrc, /anchorPad:\s*44/, "U8: station identity popover uses anchorPad 44");

  for (const entryRel of ["../widget.tsx", "../intent.tsx", "../app_intents.tsx"]) {
    const entrySrc = readFileSync(new URL(entryRel, import.meta.url), "utf8");
    assert.match(entrySrc, /synchronizeMeals/, `8.3 #10: ${entryRel} pulls cloud meal pickup codes`);
  }

  const recSrc = readFileSync(new URL("../pages/RecognitionSettingsPage.tsx", import.meta.url), "utf8");
  assert.match(recSrc, /disabled=\{testing \|\| \(draft\.mode === "online" && !hasInputs\)\}/, "IOS-SR-07 (1): checkmark disabled while testing");
  assert.match(recSrc, /popover=\{\{[\s\S]*?isPresented: showProviders[\s\S]*?<Image systemName="checkmark"[\s\S]*?<Text>\{PROVIDER_NAMES\[provider\]\}<\/Text>[\s\S]*?<ProviderLogo provider=\{provider\} \/>/, "U2: Provider selector uses popover with [checkmark] Name [logo]");
  assert.match(recSrc, /<Text foregroundStyle="accentColor" lineLimit=\{1\}>\{providerTitle\}<\/Text>\s*<ProviderLogo provider=\{draft\.provider\} \/>\s*<Image systemName="chevron\.up\.chevron\.down"/, "U2: button row content [providerTitle] [ProviderLogo] [chevron]");
  assert.match(recSrc, /<Section footer=\{<Text>连接测试使用内置样图，不保存设置或生成卡片。<\/Text>\}>/, "U2: concise 22-char 1-line Section 2 footer");
  assert.match(recSrc, /missingInputsNotice/, "IOS-SR-07 (4): empty required fields guidance");
  assert.match(recSrc, /prompt=\{canReuseKey \? "•"\.repeat\(saved\.keyLength\) : "请输入 API Key"\}/, "IOS-SR-07 (5): full saved.keyLength mask");
});

test("LIVE BUG 4: synchronizeParcelCloudRecords + enrichPendingCloudShipments immediately enriches pending PDD & manual cloud rows without false notification", async () => {
  clock = NOW;
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();
  widgetReloadCount = 0;
  scheduledNotifications.length = 0;

  saveGatewayToken("AbCdEfGh_123-456");
  saveState(emptyState(), clock);

  const ownerId = "a".repeat(64);
  const endpointId = `scripting-parcel:${"b".repeat(64)}`;
  const epoch = "11111111-2222-4333-8444-555555555555";
  const pddWaybill = "YT202611268801";
  const manualWaybill = "STO202611268802";

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/scripting-parcels/session")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, schemaVersion: 1, enabled: true, ownerId, endpointId, epoch, generation: 1, nextSequence: 1, cursor: 2,
        }),
      };
    }
    if (path.endsWith("/scripting-parcels/pull")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const isSnap = body.epoch === "";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId,
          endpointId,
          epoch,
          generation: 1,
          nextSequence: 1,
          cursor: 2,
          mode: isSnap ? "snapshot" : "delta",
          reset: isSnap,
          hasMore: false,
          pageToken: null,
          records: isSnap
            ? [
                {
                  recordId: "22222222-3333-4444-8555-666666666671",
                  type: "express",
                  revision: 1,
                  changedAt: clock - 60_000,
                  editedAt: clock - 60_000,
                  lifecycle: "active",
                  historyAt: 0,
                  deleted: false,
                  payload: {
                    waybill: pddWaybill,
                    carrierCode: "YTO",
                    phone4: "1234",
                    importOrigin: "pdd",
                    status: "TRANSIT",
                    eventAt: clock - 60_000,
                    createdAt: clock - 60_000,
                    updatedAt: clock - 60_000,
                  },
                },
                {
                  recordId: "22222222-3333-4444-8555-666666666672",
                  type: "express",
                  revision: 2,
                  changedAt: clock - 50_000,
                  editedAt: clock - 50_000,
                  lifecycle: "active",
                  historyAt: 0,
                  deleted: false,
                  payload: {
                    waybill: manualWaybill,
                    carrierCode: "STO",
                    phone4: "",
                    status: "TRANSIT",
                    eventAt: clock - 50_000,
                    createdAt: clock - 50_000,
                    updatedAt: clock - 50_000,
                  },
                },
              ]
            : [],
        }),
      };
    }
    if (path === "/api/express/timeline/source") {
      const body = JSON.parse(String(init?.body || "{}"));
      const bill = String(body.waybill || body.nu || "");
      // Simulate v6_query empty for manualWaybill so fallback v4_query (/api/express/timeline/public) handles it!
      if (bill === manualWaybill) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, value: { nu: bill, com: "STO", state: "0", data: [] } }) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 200,
          value: {
            nu: bill,
            com: "YTO",
            state: "0",
            data: [{ time: "2026-11-26 14:30:00", context: `${bill} 运输中` }],
          },
        }),
      };
    }
    if (path === "/api/express/timeline/public") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: "0",
          data: {
            cpCode: "STO",
            cpName: "申通快递",
            logisticsStatus: "TRANSIT",
            logisticsStatusDesc: "运输中",
            fullTraceDetail: [{ time: "2026-11-26 14:35:00", desc: `${manualWaybill} 申通发车` }],
          },
        }),
      };
    }
    if (path.endsWith("/scripting-parcels/mutate")) {
      const body = JSON.parse(String(init?.body || "{}"));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          schemaVersion: 1,
          enabled: true,
          ownerId,
          endpointId,
          epoch,
          generation: 1,
          nextSequence: (Number(body.sequence) || 1) + 1,
          cursor: 3,
          results: Array.isArray(body.mutations)
            ? body.mutations.map((m: { recordId: string; baseRevision?: number }) => ({
                recordId: m.recordId,
                status: "applied",
                revision: (Number(m.baseRevision) || 0) + 1,
              }))
            : [],
        }),
      };
    }
    throw new Error(`unexpected fetch path: ${path}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  // Immediately after cloud sync, both are pending and hidden from visibleShipments
  assert.equal(visibleShipments(loadState(clock), clock).length, 0);

  const published: unknown[] = [];
  const enrichedState = await enrichPendingCloudShipments((s) => published.push(s));
  assert.ok(enrichedState, "enrichPendingCloudShipments returns updated AppState");
  const visible = visibleShipments(enrichedState, clock);
  assert.equal(visible.length, 2, "both PDD cloud parcel and manual cloud parcel appear in HomePage visibleShipments immediately");
  assert.ok(visible.some((s) => s.pddCloudOrigin?.waybill === pddWaybill && s.timeline.provider !== "pending"));
  assert.ok(visible.some((s) => s.timeline.waybill === manualWaybill && s.timeline.provider !== "pending"));
  assert.equal(enrichedState.pendingNotifications?.length ?? 0, 0, "first-discovery enrichment suppresses status notifications");
  assert.ok(published.length >= 1, "publish callback receives enriched state");
  assert.ok(widgetReloadCount >= 1, "widget reload triggered after visible cloud parcel enrichment");
});

test("三-5 & 三-6: pdd-cloud-records bindSnapshot + 409 retry, and errorMessage host-error sanitization", async () => {
  // 三-6: raw English host/network errors fall back to localized copy; Chinese business messages pass through
  assert.equal(
    errorMessage(new TypeError("The Internet connection appears to be offline."), EXPRESS_TOAST_COPY.codeSendFailed),
    EXPRESS_TOAST_COPY.codeSendFailed,
  );
  assert.equal(
    errorMessage(new Error("Network request failed"), EXPRESS_TOAST_COPY.bindFailed),
    EXPRESS_TOAST_COPY.bindFailed,
  );
  assert.equal(
    errorMessage(new Error("验证码错误，请重新输入"), EXPRESS_TOAST_COPY.bindFailed),
    "验证码错误，请重新输入",
  );

  // 三-5: bindSnapshot + 409 cloud_snapshot_changed restarts from page 1 cleanly
  saveGatewayToken("AbCdEfGh_123-456");
  const requests: Array<Record<string, unknown>> = [];
  let page2FailedOnce = false;
  const snap1 = "1".repeat(64);
  const snap2 = "2".repeat(64);
  const page1Cursor = "00000000-0000-4000-8000-000000000001";

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push(body);
    if (!body.after) {
      const currentSnap = page2FailedOnce ? snap2 : snap1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          snapshot: currentSnap,
          nextAfter: page1Cursor,
          parcels: [{ waybill: "SF202611260001", anchorAt: clock - 10_000, carrierCode: "SF", phone4: "8888" }],
        }),
      };
    }
    if (!page2FailedOnce) {
      page2FailedOnce = true;
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ ok: false, error: "cloud_snapshot_changed" }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        snapshot: snap2,
        nextAfter: null,
        parcels: [{ waybill: "YT202611260002", anchorAt: clock - 5_000, carrierCode: "YTO", phone4: "9999" }],
      }),
    };
  }) as typeof fetch;

  const controller = new AbortController();
  const parcels = await readCloudPddParcels(controller.signal, clock + 10_000);
  assert.equal(requests.length, 4, "page1 -> page2(409) -> retry page1 -> retry page2");
  assert.equal(requests[0]?.bindSnapshot, true);
  assert.equal(requests[1]?.snapshot, snap1);
  assert.equal(requests[3]?.snapshot, snap2);
  assert.deepEqual(parcels.map((p) => p.waybill), ["SF202611260001", "YT202611260002"]);
});

test("三-13: 中通国际 & zhongtongguoji resolve to ZTO (中通快递, icon zto, query zhongtong)", () => {
  const byName = resolveCarrierName("中通国际");
  assert.equal(byName?.standardCode, "ZTO");
  assert.equal(byName?.displayName, "中通快递");
  assert.equal(carrierDisplayName("中通国际"), "中通快递");
  assert.equal(courierIconName("", "中通国际"), "zto");

  const byK100 = resolveCarrierKuaidi100Code("zhongtongguoji");
  assert.equal(byK100?.standardCode, "ZTO");
  assert.equal(byK100?.kuaidi100Code, "zhongtong");
  assert.equal(resolveCarrierQuery("ZTO")?.kuaidi100Code, "zhongtong");
  assert.equal(courierIconName("zhongtongguoji", ""), "zto");
});

test("8.6 #5, 8.4 #6 & 8.3 #8: field preservation + JD duplicate elimination, H5 priority queue, and Watch status notifications", async () => {
  // 1. 8.6 #5: Manual row with pickup + forcedCompletedAtMs + manualTitle absorbed by JD order projection without transient duplicate
  const waybill = "JDVA2026112699";
  const manualRow = {
    identity: {
      id: `interface5:manual:${waybill}`,
      bindingSource: "interface5" as const,
      sourceOwner: "manual",
      sourceId: waybill,
      phoneTail: "1234",
      courierCode: "JD",
      companyName: "京东快递",
      manuallyAdded: true,
      createdAtMs: clock - 100_000,
    },
    timeline: {
      provider: "v6_query",
      waybill,
      courierCode: "JD",
      companyName: "京东快递",
      semantic: "WAITING_PICKUP" as const,
      structuredStatus: true,
      statusEventAtMs: clock - 50_000,
      latestTimeText: "2026-11-26 12:00:00",
      latestDetail: "已到驿站",
      successAtMs: clock - 50_000,
      tracks: [{ timeText: "2026-11-26 12:00:00", timeMs: clock - 50_000, detail: "已到驿站", statusCode: "WAITING_PICKUP", raw: {} }],
    },
    pickup: {
      waybill,
      waybillGeneration: 0,
      capturedAtMs: clock - 40_000,
      code: "8-2-1024",
      locationName: "菜鸟驿站",
    },
    platformFields: {
      waybill,
      waybillGeneration: 0,
      manualTitle: "机械键盘",
      manualTitleEditedAtMs: clock - 30_000,
      estimate: { text: "预计今日送达", source: "cainiao" as const, capturedAtMs: clock - 35_000 },
    },
    forcedCompletedAtMs: clock - 10_000,
    settledAtMs: clock - 10_000,
    note: "放快递柜",
    updatedAtMs: clock - 10_000,
  };
  const unprojectedJdOrder = {
    identity: {
      id: "interface5:account:ORDER998877",
      bindingSource: "interface5" as const,
      sourceOwner: "13800138000",
      sourceId: "ORDER998877",
      orderId: "ORDER998877",
      sourceProvider: "jingdong",
      phone: "13800138000",
      phoneTail: "8000",
      courierCode: "JD",
      companyName: "京东购物",
      accountOrder: true,
      manuallyAdded: false,
      createdAtMs: clock - 90_000,
    },
    timeline: {
      provider: "interface5",
      waybill: "ORDER998877",
      courierCode: "JD",
      companyName: "京东购物",
      semantic: "ORDERED" as const,
      structuredStatus: true,
      statusEventAtMs: clock - 90_000,
      latestTimeText: "2026-11-26 10:00:00",
      latestDetail: "您提交了订单",
      successAtMs: clock - 90_000,
      tracks: [{ timeText: "2026-11-26 10:00:00", timeMs: clock - 90_000, detail: "您提交了订单", statusCode: "ORDERED", raw: {} }],
    },
    updatedAtMs: clock - 90_000,
  };

  const projectedShipments = applyAccountOrderProjectionToOwner(
    [manualRow, unprojectedJdOrder],
    {
      source: "interface5",
      phone: "13800138000",
      ownerId: "ORDER998877",
      orderId: "ORDER998877",
      waybill,
      accountOrder: true,
      sourceProvider: "jingdong",
      courierCode: "JD",
      companyName: "京东快递",
      rawCourierCode: "JD",
      rawCompanyName: "京东快递",
      statusText: "运输中",
      statusCode: "TRANSIT",
      updatedAtMs: clock,
      tracks: [{ timeText: "2026-11-26 11:00:00", timeMs: clock - 60_000, detail: "京东揽收", statusCode: "PICKED", raw: {} }],
      routeUrl: "",
      projectionUrl: "",
    } as Parameters<typeof applyAccountOrderProjectionToOwner>[1],
    ["13800138000"],
    clock,
    new Map(),
  );
  assert.equal(
    JSON.stringify(projectedShipments.find((s) => s.identity.id === manualRow.identity.id)),
    JSON.stringify(manualRow),
    "projection never rewrites the manual row in stored state (归属-1)",
  );
  const visibleAfterProjection = visibleShipments({ ...emptyState(), shipments: projectedShipments }, clock);
  assert.equal(visibleAfterProjection.length, 1, "visibleShipments immediately hides superseded manual duplicate");
  const survivor = visibleAfterProjection[0]!;
  assert.equal(survivor.identity.id, unprojectedJdOrder.identity.id);
  assert.equal(survivor.pickup?.code, "8-2-1024", "pickup code preserved across JD projection takeover");
  assert.equal(survivor.forcedCompletedAtMs, clock - 10_000, "forcedCompletedAtMs preserved");
  assert.equal(survivor.platformFields?.manualTitle, "机械键盘", "manualTitle preserved");
  assert.equal(survivor.platformFields?.estimate?.text, "预计今日送达", "non-PDD estimate preserved");
  assert.equal(survivor.note, "放快递柜", "note preserved");

  // Direct absorbManualShipment and attached automatic row propagation via withWaybillOwnership
  const directAbsorbed = absorbManualShipment(
    { ...survivor, pickup: undefined, forcedCompletedAtMs: undefined, platformFields: undefined, note: undefined },
    manualRow,
    clock,
  );
  assert.equal(directAbsorbed.pickup?.code, "8-2-1024");
  assert.equal(directAbsorbed.forcedCompletedAtMs, clock - 10_000);
  assert.equal(directAbsorbed.platformFields?.manualTitle, "机械键盘");

  const firstAuto = {
    ...manualRow,
    identity: { ...manualRow.identity, id: `interface6:auto1:${waybill}`, manuallyAdded: false, sourceProvider: "cainiao", createdAtMs: clock - 200_000 },
    pickup: undefined,
    forcedCompletedAtMs: undefined,
    platformFields: undefined,
  };
  const secondAuto = {
    ...manualRow,
    identity: { ...manualRow.identity, id: `interface6:auto2:${waybill}`, manuallyAdded: false, sourceProvider: "jingdong", createdAtMs: clock - 150_000 },
  };
  const owned = withWaybillOwnership(null, [firstAuto, secondAuto], clock, (s) => ({ ...s, timeline: selectShipmentTimeline(s) }));
  const attached = attachedShipmentIds(owned);
  assert.equal(attached.has(secondAuto.identity.id), true);
  const occupant = owned.find((s) => s.identity.id === firstAuto.identity.id)!;
  assert.equal(occupant.pickup?.code, "8-2-1024", "attached row hands pickup code to visible occupant");
  assert.equal(occupant.forcedCompletedAtMs, clock - 10_000, "attached row hands forcedCompletedAtMs to visible occupant");
  assert.equal(occupant.platformFields?.manualTitle, "机械键盘", "attached row hands manualTitle to visible occupant");

  // 2. 8.4 #6: Interactive DetailPage H5 capture jumps ahead of queued background shopping-list H5 tasks
  memory.clear();
  const h5Runtime = createSyncRuntimeState();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });

  const p1 = withH5Controller(h5Runtime, async () => {
    order.push("bg-1");
    await firstGate;
  }, clock + 10_000, undefined, "background");
  await new Promise((r) => setTimeout(r, 5));
  const p2 = withH5Controller(h5Runtime, async () => {
    order.push("bg-2");
  }, clock + 10_000, undefined, "background");
  const p3 = withH5Controller(h5Runtime, async () => {
    order.push("detail-interactive");
  }, clock + 10_000, undefined, "interactive");

  releaseFirst();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["bg-1", "detail-interactive", "bg-2"], "interactive DetailPage H5 runs ahead of queued background tasks");

  // 3. 8.3 #8: Initial Watch snapshot import does NOT notify; subsequent status change DOES schedule local notification
  memory.clear();
  scheduledNotifications.length = 0;
  saveGatewayToken("AbCdEfGh_123-456");
  saveState(emptyState(), clock);

  const watchId = "99999999-8888-4777-8666-555555555555";
  let watchStatus = "TRANSIT";
  let watchDetail = "Arrived at Frankfurt";
  let watchSnap = "a".repeat(64);
  let watchUpdated = clock - 60_000;

  globalThis.fetch = (async (url: string) => {
    if (new URL(url).pathname === "/api/cloud-records/international-shipments") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          snapshot: watchSnap,
          nextAfter: null,
          parcels: [{
            id: watchId,
            waybill: "DHL88990011",
            carrierName: "DHL",
            icon: "dhl",
            status: watchStatus,
            statusText: watchDetail,
            updatedAt: watchUpdated,
            tracks: [{ at: watchUpdated, detail: watchDetail }],
          }],
        }),
      };
    }
    throw new Error(`unexpected Watch fetch: ${url}`);
  }) as typeof fetch;

  await refreshStoredWatchShipments(5_000);
  assert.equal(scheduledNotifications.length, 0, "initial Watch snapshot import never schedules notifications");

  clock += 180_000;
  watchStatus = "DELIVERY";
  watchDetail = "Out for delivery with courier";
  watchSnap = "b".repeat(64);
  watchUpdated = clock - 5_000;
  await refreshStoredWatchShipments(5_000);
  assert.equal(scheduledNotifications.length, 1, "subsequent Watch status change schedules local iOS notification");
  assert.match(scheduledNotifications[0]!.title, /DHL/);
  assert.equal(scheduledNotifications[0]!.body, "Out for delivery with courier");
});

test("W1: deleting watch:<uuid1> on iOS then re-tracking same waybill in Bot as watch:<uuid2> with identical scans revives watch:<uuid2>", async () => {
  memory.clear();
  resetParcelCloudDeniedBackoffForTests();
  saveGatewayToken("AbCdEfGh_123-456");
  const scope = activeWatchScope();
  assert.ok(scope);

  const uuid1 = "11111111-1111-4111-8111-111111111111";
  const uuid2 = "22222222-2222-4222-8222-222222222222";
  const waybill = "UPS1Z999AA10123456";
  const scanTime = clock - 300_000;

  // 1. Seed initial Watch parcel watch:<uuid1> and delete it on iOS
  const row1 = internationalShipmentSnapshot({
    id: uuid1,
    waybill,
    carrierName: "UPS",
    icon: "ups",
    status: "TRANSIT",
    statusText: "运输中",
    updatedAt: scanTime,
    tracks: [{ at: scanTime, detail: "Departed facility" }],
  }, clock);
  const initial = commitWatchSnapshot({ scope, snapshot: "1".repeat(64), observedAtMs: clock - 10_000, shipments: [row1] });
  assert.equal(visibleShipments(initial, clock).length, 1);

  const deleteAt = clock;
  const afterDelete = removeShipment(`watch:${uuid1}`, deleteAt);
  assert.equal(visibleShipments(afterDelete, deleteAt).length, 0);
  assert.equal(afterDelete.watchFeedback?.[0]?.watchRecordId, uuid1);
  assert.equal(afterDelete.watchFeedback?.[0]?.action, "deleted");

  // Same old Watch record uuid1 with unchanged scan stays hidden
  clock += 5_000;
  const stillOld = commitWatchSnapshot({ scope, snapshot: "2".repeat(64), observedAtMs: clock, shipments: [row1] });
  assert.equal(visibleShipments(stillOld, clock).length, 0, "same Watch record uuid1 without newer scan stays hidden");

  // 2. User re-tracks same waybill in Bot -> brand-new uuid2 with updatedAt > deleteAt and IDENTICAL scan timestamp
  clock += 5_000;
  const retrackedAt = clock;
  const row2 = internationalShipmentSnapshot({
    id: uuid2,
    waybill,
    carrierName: "UPS",
    icon: "ups",
    status: "TRANSIT",
    statusText: "运输中",
    updatedAt: retrackedAt,
    tracks: [{ at: scanTime, detail: "Departed facility" }],
  }, clock);
  const revived = commitWatchSnapshot({ scope, snapshot: "3".repeat(64), observedAtMs: clock, shipments: [row2] });
  const visibleRevived = visibleShipments(revived, clock);
  assert.equal(visibleRevived.length, 1, "re-tracked watch:<uuid2> revives immediately despite identical scan timestamp");
  assert.equal(visibleRevived[0]!.identity.id, `watch:${uuid2}`);
  assert.equal(revived.watchFeedback?.length ?? 0, 0, "stale uuid1 delete feedback is retired");

  // 3. Stale cloud express_watch_feedback (both uuid1-bound and waybill-only with actedAt <= deleteAt < retrackedAt) cannot hide watch:<uuid2>
  const ownerId = "a".repeat(64);
  const endpointId = `scripting-parcel:${"b".repeat(64)}`;
  const epoch = "33333333-3333-4333-8333-333333333333";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/scripting-parcels/session")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, schemaVersion: 1, enabled: true, ownerId, endpointId, epoch, generation: 1, nextSequence: 1, cursor: 2,
          expressWatchFeedbackSupported: true,
        }),
      };
    }
    if (path.endsWith("/scripting-parcels/pull")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const isSnap = body.epoch === "";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, schemaVersion: 1, enabled: true, ownerId, endpointId, epoch, generation: 1, nextSequence: 1, cursor: 2,
          mode: isSnap ? "snapshot" : "delta", reset: isSnap, hasMore: false, pageToken: null,
          records: isSnap
            ? [
                {
                  recordId: "44444444-4444-4444-8444-444444444441",
                  type: "express_watch_feedback",
                  revision: 1,
                  changedAt: deleteAt,
                  editedAt: deleteAt,
                  lifecycle: "active",
                  historyAt: 0,
                  deleted: false,
                  payload: { waybill, watchRecordId: uuid1, action: "deleted", actedAt: deleteAt },
                },
                {
                  recordId: "44444444-4444-4444-8444-444444444442",
                  type: "express_watch_feedback",
                  revision: 2,
                  changedAt: deleteAt,
                  editedAt: deleteAt,
                  lifecycle: "active",
                  historyAt: 0,
                  deleted: false,
                  payload: { waybill, action: "deleted", actedAt: deleteAt },
                },
              ]
            : [],
        }),
      };
    }
    if (path.endsWith("/scripting-parcels/mutate")) {
      const body = JSON.parse(String(init?.body || "{}"));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, schemaVersion: 1, enabled: true, ownerId, endpointId, epoch, generation: 1,
          nextSequence: (Number(body.sequence) || 1) + 1, cursor: 2, results: [],
        }),
      };
    }
    throw new Error(`unexpected path: ${path}`);
  }) as typeof fetch;

  await synchronizeParcelCloudRecords();
  const afterCloudSync = loadState(clock);
  assert.equal(visibleShipments(afterCloudSync, clock).length, 1, "stale cloud feedback does not delete re-tracked watch:<uuid2>");
  assert.equal(visibleShipments(afterCloudSync, clock)[0]!.identity.id, `watch:${uuid2}`);
  assert.equal(afterCloudSync.watchFeedback?.length ?? 0, 0, "stale cloud feedback does not pollute watchFeedback");
});

test("JD o.m.jd.com/list migration: Fiber Zustand store extraction (orders, empty [], status=3 expired) & passport.m.jd.com", async () => {
  // 1. Diagnostic classification & cookie login proof on o.m.jd.com and passport.m.jd.com
  assert.equal(jdDiagnosticPage("https:", "o.m.jd.com"), "jd_orders");
  assert.equal(jdDiagnosticPage("https:", "passport.m.jd.com"), "jd_login");
  const canaryCookies = [
    { name: "pt_key", value: "synthetic-canary-key", domain: "o.m.jd.com", path: "/", isSecure: true },
    { name: "pt_pin", value: "jd_canary_user", domain: "o.m.jd.com", path: "/", isSecure: true },
  ];
  assert.deepEqual(jdLoginProof(canaryCookies), { id: "jd_canary_user", proof: "synthetic-canary-key" });

  // 2. End-to-end fetchJdParcels when trade.m.jd.com redirects to https://o.m.jd.com/list?__canary=1
  memory.clear();
  setProjectionSceneActive(true);
  const jdOrderId = "31202611260001";
  const jdWaybill = "JDVA2026112688";
  const storedJdShipment = {
    identity: {
      id: `interface5:account:${jdOrderId}`,
      bindingSource: "interface5" as const,
      sourceOwner: "13800138000",
      sourceId: jdOrderId,
      orderId: jdOrderId,
      projectedWaybill: jdWaybill,
      sourceProvider: "jingdong",
      courierCode: "JD",
      companyName: "京东快递",
      accountOrder: true,
      manuallyAdded: false,
      createdAtMs: clock - 60_000,
    },
    timeline: {
      provider: "interface5",
      waybill: jdWaybill,
      courierCode: "JD",
      companyName: "京东快递",
      semantic: "WAITING_PICKUP" as const,
      structuredStatus: true,
      statusEventAtMs: clock - 30_000,
      latestTimeText: "2026-11-26 16:00:00",
      latestDetail: "待取件",
      successAtMs: clock - 30_000,
      tracks: [{ timeText: "2026-11-26 16:00:00", timeMs: clock - 30_000, detail: "待取件", statusCode: "WAITING_PICKUP", raw: {} }],
    },
    updatedAtMs: clock - 30_000,
  };

  let mode: "orders" | "empty" | "status3_expired" | "passport_expired" = "orders";
  let currentUrl = new URL("about:blank");
  const originalWebViewController = (globalThis as Record<string, unknown>).WebViewController;

  const makeCanaryFiberRoot = (orderListState: Record<string, unknown>) => {
    const zustandStore = { state: () => ({ orderList: orderListState }) };
    const leafFiber = {
      dependencies: {
        firstContext: {
          next: {
            memoizedValue: zustandStore,
            next: null,
          },
        },
      },
    };
    return {
      __reactContainer$canary57: {
        child: {
          sibling: leafFiber,
        },
      },
    };
  };

  (globalThis as Record<string, unknown>).WebViewController = class {
    cookies: Array<Record<string, unknown>> = [];
    async setCookie(c: Record<string, unknown>) { this.cookies.push(c); return true; }
    async getAllCookies() { return this.cookies; }
    async loadURL(url: string) {
      if (url.startsWith("https://trade.m.jd.com/order/orderlist_jdm.shtml")) {
        currentUrl = new URL(
          mode === "passport_expired"
            ? "https://passport.m.jd.com/new/login.action"
            : "https://o.m.jd.com/list?__canary=57",
        );
      } else {
        currentUrl = new URL(url);
      }
      return true;
    }
    async evaluateJavaScript(script: string) {
      const win: Record<string, unknown> = { innerWidth: 390, innerHeight: 844 };
      win.top = win;
      const onDetail = currentUrl.pathname.endsWith("/deal_wuliu_jdm.shtml");
      if (onDetail) {
        const summary = {
          querySelectorAll: (sel: string) =>
            sel.includes("data-copy-cont")
              ? [{ getAttribute: () => jdWaybill }]
              : [{ textContent: "MacBook Pro 电源适配器" }],
        };
        const doc = {
          readyState: "complete",
          body: { innerText: `运单号：${jdWaybill}\n取件码：6-3-2048` },
          querySelector: (sel: string) => (sel.includes("Summary-module") ? summary : null),
          querySelectorAll: () => [],
        };
        return runInNewContext(`(() => {${script}})()`, { window: win, document: doc, location: currentUrl, URLSearchParams });
      }
      const orderState =
        mode === "status3_expired"
          ? { status: 3 }
          : mode === "empty"
            ? {
                status: 0,
                loading: false,
                params: { functionId: "newUserAllOrderList" },
                listQurTime: { newUserAllOrderList: clock },
                data: { orderList: { newUserAllOrderList: [] } },
              }
            : {
                status: 0,
                loading: false,
                params: { functionId: "newUserAllOrderList" },
                listQurTime: { newUserAllOrderList: clock },
                data: {
                  orderList: {
                    newUserAllOrderList: [
                      {
                        orderId: jdOrderId,
                        shopId: "100000123",
                        orderStatusShow: "待收货",
                        orderMsg: { wareInfoList: [{ wareId: "99887766", wname: "MacBook Pro 电源适配器" }] },
                        trackProgress: { title: "运输中", message: "预计11月27日送达" },
                      },
                    ],
                  },
                },
              };
      const appEl = makeCanaryFiberRoot(orderState);
      const doc = {
        readyState: "complete",
        body: { innerText: "" },
        getElementById: (id: string) => (id === "app" ? appEl : null),
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return runInNewContext(`(() => {${script}})()`, { window: win, document: doc, location: currentUrl, URLSearchParams });
    }
    dispose() {}
  };

  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    const baseCookie = { name: "pt_key", value: "synthetic-jd-canary", domain: ".jd.com", path: "/", isSecure: true };
    const pinCookie = { name: "pt_pin", value: "jd_user_1", domain: ".jd.com", path: "/", isSecure: true };

    // Case A: Populated orders on o.m.jd.com/list -> extracts title, forecast, and opens detail page for pickup code
    savePlatformLogin("jingdong", "", { kind: "web", cookies: [baseCookie, pinCookie] }, "jd_user_1", "京东测试昵称");
    const savedOrderFields: Array<Record<string, unknown>> = [];
    const resOrders = await fetchJdParcels(platformSession("jingdong")!, [storedJdShipment], (fields) => {
      savedOrderFields.push(...(fields as unknown as Array<Record<string, unknown>>));
    });
    assert.equal(savedOrderFields.length, 1, "saves associated JD order fields from o.m.jd.com Zustand store");
    assert.equal(savedOrderFields[0]?.title, "MacBook Pro 电源适配器");
    assert.match(String(savedOrderFields[0]?.estimate || ""), /11月27日/);
    assert.equal(resOrders.parcels.length, 1);
    assert.equal(resOrders.parcels[0]?.code, "6-3-2048");

    // Case B: Empty order list on o.m.jd.com/list -> returns { parcels: [] } cleanly without timing out
    mode = "empty";
    const resEmpty = await fetchJdParcels(platformSession("jingdong")!, [storedJdShipment], () => {});
    assert.deepEqual(resEmpty.parcels, []);

    // Case C: o.m.jd.com Zustand store status === 3 (LOGIN_ERROR) -> marks JD session expired
    mode = "status3_expired";
    await assert.rejects(
      fetchJdParcels(platformSession("jingdong")!, [storedJdShipment], () => {}),
      (err: unknown) => err instanceof PlatformWireError && err.reason === "expired",
    );
    assert.equal(accountStatus("jingdong").state, "expired");

    // Case D: Redirect to passport.m.jd.com -> marks JD session expired
    savePlatformLogin("jingdong", accountStatus("jingdong").generation, { kind: "web", cookies: [baseCookie, pinCookie] }, "jd_user_1", "京东测试昵称");
    mode = "passport_expired";
    await assert.rejects(
      fetchJdParcels(platformSession("jingdong")!, [storedJdShipment], () => {}),
      (err: unknown) => err instanceof PlatformWireError && err.reason === "expired",
    );
    assert.equal(accountStatus("jingdong").state, "expired");
  } finally {
    const activeGen = accountStatus("jingdong").generation;
    if (activeGen) clearPlatformLogin("jingdong", activeGen);
    (globalThis as Record<string, unknown>).WebViewController = originalWebViewController;
    registerProjectionViewportHost(null);
  }
});

test("U9: PDD order sync attaches pddImport shippingId onto existing cloud-imported PDD row and parses jump_url order_sn", async () => {
  clock = NOW;
  memory.clear();
  const sfBill = "SF0000000001002";
  const cloudPddRow = {
    identity: {
      id: `interface5:manual:${sfBill}`,
      bindingSource: "interface5" as const,
      sourceOwner: "manual" as const,
      sourceId: sfBill,
      phoneTail: "",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: true,
      createdAtMs: clock - 3_600_000,
    },
    timeline: {
      provider: "kdniao" as const,
      waybill: sfBill,
      courierCode: "SF",
      companyName: "顺丰速运",
      semantic: "COMPLETED" as const,
      structuredStatus: true,
      statusEventAtMs: clock - 600_000,
      latestTimeText: "2026-11-26 18:48:38",
      latestDetail: "您的快件已派送成功",
      tracks: [{
        timeMs: clock - 600_000,
        timeText: "2026-11-26 18:48:38",
        detail: "您的快件已派送成功",
        statusCode: "301",
        raw: {},
      }],
      successAtMs: clock - 600_000,
    },
    sourceTimeline: null,
    manualTimelines: [],
    pddCloudOrigin: { waybill: sfBill, waybillGeneration: 0 },
    updatedAtMs: clock - 600_000,
  };
  const seeded = saveState({ ...emptyState(), shipments: [cloudPddRow] }, clock);
  assert.equal(seeded.shipments[0]?.pddImport, undefined);

  const originalWebViewController = (globalThis as Record<string, unknown>).WebViewController;
  let userScript = "";
  (globalThis as Record<string, unknown>).WebViewController = class {
    url = "https://mobile.yangkeduo.com/orders.html";
    async setCookie() { return true; }
    async addUserScript(opts: { source: string }) {
      userScript = opts.source;
      return "script-id";
    }
    async loadURL() { return true; }
    async evaluateJavaScript(script: string) {
      const currentUrl = new URL("https://mobile.yangkeduo.com/orders.html");
      const sandbox: Record<string, unknown> = {
        location: currentUrl,
        document: { body: { innerText: "" } },
        URL,
        URLSearchParams,
        fetch: async (reqUrl: string) => ({
          ok: true,
          url: reqUrl,
          clone: () => ({
            text: async () => JSON.stringify({
              error_code: 0,
              result: {
                track_info_list: [{
                  tracking_number: sfBill,
                  shipping_id: "115",
                  jump_url: `/psnl_goods_help.html?_t_module_name=assistant_waybill&shipping_id=115&tracking_number=${sfBill}&order_sn=261125-00000123456`,
                }],
              },
            }),
          }),
        }),
        XMLHttpRequest: class { send() {} addEventListener() {} },
      };
      sandbox.window = sandbox;
      sandbox.top = sandbox;
      runInNewContext(userScript, sandbox);
      await (sandbox.fetch as (u: string) => Promise<unknown>)("https://mobile.yangkeduo.com/proxy/api/api/express_trackbox/list");
      await new Promise((r) => setTimeout(r, 0));
      return runInNewContext(`(() => {${script}})()`, sandbox);
    }
    dispose() {}
  };
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  try {
    savePlatformLogin(
      "pinduoduo",
      "",
      {
        kind: "web",
        cookies: [
          { name: "PDDAccessToken", value: "synthetic-pdd-token", domain: ".yangkeduo.com", path: "/", isSecure: true },
          { name: "pdd_user_id", value: "424242", domain: ".yangkeduo.com", path: "/", isSecure: true },
        ],
      },
      "424242",
      "测试拼多多",
    );
    const session = platformSession("pinduoduo")!;
    const orders = await fetchPddOrders(session);
    assert.equal(orders.length, 1);
    assert.equal(orders[0]?.waybill, sfBill);
    assert.equal(orders[0]?.shippingId, "115");
    assert.deepEqual(orders[0]?.orderIds, ["261125-00000123456"]);

    const saved = savePlatformParcelData(
      { observed: seeded, owner: session.ownerKey, parcels: orders, current: () => true },
      clock + 1_000,
    );
    assert.equal(saved.changed, true);
    const updated = saved.state.shipments[0]!;
    assert.deepEqual(updated.pddImport, {
      ownerKey: session.ownerKey,
      orderId: "261125-00000123456",
      shippingId: "115",
    });
    assert.equal(
      pddParcelAppURL(updated.pddImport, sfBill),
      `pinduoduo://com.xunmeng.pinduoduo/psnl_goods_help.html?_t_module_name=assistant_waybill&shipping_id=115&tracking_number=${sfBill}`,
    );
  } finally {
    const gen = accountStatus("pinduoduo").generation;
    if (gen) clearPlatformLogin("pinduoduo", gen);
    (globalThis as Record<string, unknown>).WebViewController = originalWebViewController;
    registerProjectionViewportHost(null);
  }
});
