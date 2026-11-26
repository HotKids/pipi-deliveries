// Diagnostics log plan (docs/DIAGNOSTICS_LOG_PLAN_20261121.md), Deliveries iOS step 7 close-out:
// - D201 (owner 2026-11-21 「只记失败，成功并入流程终态（推荐）」): the cloud PDD read inside a full refresh folds into
//   the refresh's end line; a failed read keeps its own line.
// - D175 (D20): account.sync.failed names the account-list condition with Pipi's fixed codes; the Worker's own code is
//   workerError.
// - D10: the text keys with a known closed set of words take only those words.
// - D170: the log page reads only keys the logger keeps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { memory } from "./state-storage-mock.ts";
import { emptyState, loadState, saveState } from "../services/storage.ts";
import { refreshAllShipments } from "../services/sync.ts";
import { parseAccountSyncResult, AccountParseError } from "../services/account-parser.ts";
import { parcelToShipment } from "../services/account-sync.ts";
import { applyAccountShipment } from "../services/shipment-policy.ts";
import { saveGatewayToken } from "../services/credentials.ts";
import { GatewayError } from "../services/gateway.ts";
import { setProjectionSceneActive } from "../services/projection-viewport.ts";
import {
  accountListFailureDetails, clearDiagnostics, CLOSED_TEXT_VALUES, DIAGNOSTIC_DETAIL_KEYS, readDiagnostics,
  setDiagnosticsEnabled, writeDiagnostic,
} from "../services/logger.ts";

const NOW = Date.UTC(2026, 10, 24, 6), PHONE = "13800000000";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class { constructor() { assert.fail("no page is opened here"); } },
});
const json = (value: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value) });
const TIME = "2026-11-24 12:00:00";
const record = {
  mailNo: "YT9990000000021", provider: "CaiNiao", cpCode: "YTO", name: "Synthetic carrier", phone: PHONE,
  stateNum: 104, details: [{ time: TIME, desc: "已到达转运中心" }],
};

function seed() {
  memory.clear();
  setDiagnosticsEnabled(true);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [record] } });
  const shipments = parsed.parcels.map(parcel => applyAccountShipment(undefined,
    parcelToShipment(parcel, [PHONE], NOW - 3_600_000)!, NOW - 3_600_000));
  saveState({ ...emptyState(), shipments,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 }],
    feedSlotRebuiltAtMs: NOW - 86_400_000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  setProjectionSceneActive(true);
  clearDiagnostics();
}

function serve(handlers: { pdd?: () => unknown; list?: () => unknown }) {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/cloud-records/pdd-shipments") {
      const answer = handlers.pdd ? handlers.pdd() : json({ ok: true, parcels: [], nextAfter: null });
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path === "/api/express/accounts/sync") {
      return handlers.list ? handlers.list() : json({ code: 0, data: { expressList: [record] } });
    }
    return json({ code: 0, data: record });
  }) as typeof fetch;
}

const pddLines = () => readDiagnostics().filter(entry => entry.event.startsWith("cloud.sync.") && entry.details.domain === "pdd");
const refreshEnd = () => readDiagnostics().find(entry => entry.event === "refresh.succeeded" || entry.event === "refresh.failed");

test("D201: a cloud PDD read inside a full refresh is folded into the refresh's end line", async () => {
  seed();
  serve({ pdd: () => json({ ok: true, nextAfter: null,
    parcels: [{ waybill: "YT9990000000022", anchorAt: NOW - 3_600_000, carrierCode: "YTO", phone4: "0000" }] }) });
  await refreshAllShipments("interface5", { accountOrderProjection: false });
  assert.ok(loadState(NOW).shipments.some(row => row.pddCloudOrigin?.waybill === "YT9990000000022"),
    "the cloud PDD parcel is still merged");
  assert.deepEqual(pddLines(), [], "a successful read writes no line of its own");
  const end = refreshEnd();
  assert.equal(end?.event, "refresh.succeeded");
  assert.equal(end?.details.cloudPddRecords, 1);
  assert.equal(end?.details.cloudPddChanged, true);

  // The same list again: the read changed nothing, which the refresh's end line now says.
  clearDiagnostics();
  await refreshAllShipments("interface5", { accountOrderProjection: false });
  assert.deepEqual(pddLines(), []);
  assert.equal(refreshEnd()?.details.cloudPddRecords, 1);
  assert.equal(refreshEnd()?.details.cloudPddChanged, false);
});

test("D201: a failed cloud PDD read inside a refresh still writes its own line", async () => {
  seed();
  serve({ pdd: () => new Error("synthetic network failure") });
  await refreshAllShipments("interface5", { accountOrderProjection: false });
  const failure = pddLines().find(entry => entry.event === "cloud.sync.completed");
  assert.equal(failure?.details.result, "unavailable");
  assert.equal(failure?.level, "warning");
  assert.equal(refreshEnd()?.details.cloudPddRecords, undefined, "no read answered, so the end line has no count");
});

test("D175: an account list the Worker refused names Pipi's code and keeps the Worker's own code", async () => {
  seed();
  serve({ list: () => json({ error: "upstream_unavailable" }, 502) });
  await refreshAllShipments("interface5", { accountOrderProjection: false }).catch(() => undefined);
  const failed = readDiagnostics().find(entry => entry.event === "account.sync.failed");
  assert.equal(failed?.details.failureCode, "account_list_rejected");
  assert.equal(failed?.details.workerError, "upstream_unavailable");
  assert.equal(failed?.details.httpStatus, 502);
});

test("D175: each account-list exit maps to one fixed code", () => {
  const rejected = accountListFailureDetails(new GatewayError("Access Key 无效或已失效", 401, "unauthorized"));
  assert.equal(rejected.failureCode, "account_list_rejected");
  assert.equal(rejected.workerError, "unauthorized");
  assert.equal(rejected.httpStatus, 401);
  const offline = accountListFailureDetails(new GatewayError("网络连接异常，请稍后重试"));
  assert.equal(offline.failureCode, "account_list_request_failed");
  assert.equal(offline.workerError, undefined);
  assert.equal(accountListFailureDetails(new AccountParseError()).failureCode, "account_list_invalid");
  assert.equal(accountListFailureDetails(new GatewayError("需要验证", 403, "phone_verification_required")).failureCode,
    "phone_verification_required");
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(accountListFailureDetails(abort).failureCode, "cancelled");

  setDiagnosticsEnabled(true);
  clearDiagnostics();
  writeDiagnostic("account.sync.failed", { ...rejected, workerError: "SF1234567890" }, "warning");
  writeDiagnostic("account.sync.failed", rejected, "warning");
  const [kept, unknownCode] = readDiagnostics();
  assert.equal(kept!.details.failureCode, "account_list_rejected");
  assert.equal(kept!.details.workerError, "unauthorized");
  assert.equal(unknownCode!.details.workerError, "other", "a Worker code outside the closed list reads other");
});

test("D10: closed text keys keep only their words", () => {
  setDiagnosticsEnabled(true);
  clearDiagnostics();
  writeDiagnostic("detail.timeline.selected", { statusSemantic: "COMPLETED", detailStatusSemantic: "completed",
    latestTrackSemantic: "SF1234", incompleteReason: "missing_pickup", routeKind: "cainiao", interface: "v5",
    errorCategory: "network", extractionSource: "dom_modal", pageClass: "jd", visibilityState: "visible" });
  writeDiagnostic("detail.timeline.selected", { statusSemantic: "DELIVERED_TO_LOCKER", incompleteReason: "phone_tail",
    routeKind: "taobao", interface: "v9", errorCategory: "order_3201", extractionSource: "body_text",
    pageClass: "plogin", visibilityState: "secret" });
  const [rejected, kept] = readDiagnostics();
  assert.deepEqual({ ...kept!.details, clientBuild: undefined, level: undefined }, {
    statusSemantic: "COMPLETED", incompleteReason: "missing_pickup", routeKind: "cainiao", interface: "v5",
    errorCategory: "network", extractionSource: "dom_modal", pageClass: "jd", visibilityState: "visible",
    clientBuild: undefined, level: undefined,
  });
  for (const key of Object.keys(CLOSED_TEXT_VALUES)) {
    assert.equal((rejected!.details as Record<string, unknown>)[key], undefined, key);
  }
});

const ROOT = new URL("..", import.meta.url).pathname;
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" || name === "tools" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const sources = sourceFiles(ROOT).map(path => readFileSync(path, "utf8"));

test("D10: every word the code writes for a closed key is in its set", () => {
  for (const [key, words] of Object.entries(CLOSED_TEXT_VALUES)) {
    for (const source of sources) {
      for (const match of source.matchAll(new RegExp(`\\b${key}: "([^"]*)"`, "g"))) {
        assert.ok(words!.has(match[1]!), `${key}: "${match[1]}" is written but not in the closed set`);
      }
    }
  }
  // The owning types: every member is in the set.
  const models = readFileSync(join(ROOT, "models.ts"), "utf8");
  const policy = readFileSync(join(ROOT, "services/shipment-policy.ts"), "utf8");
  const members = (declaration: RegExp, text: string) => [...(text.match(declaration)?.[1] || "").matchAll(/"([^"]+)"/g)]
    .map(match => match[1]!);
  const semantics = members(/export type StatusSemantic =([^;]+);/, models);
  assert.ok(semantics.length >= 10);
  for (const word of semantics) assert.ok(CLOSED_TEXT_VALUES.statusSemantic!.has(word), word);
  const reasons = members(/export type DetailIncompleteReason =([^;]+);/, policy);
  assert.ok(reasons.length >= 7);
  for (const word of reasons) assert.ok(CLOSED_TEXT_VALUES.incompleteReason!.has(word), word);
  for (const word of members(/export type ShipmentRoute = \{\s*kind:([^;]+);/, models)) {
    assert.ok(CLOSED_TEXT_VALUES.routeKind!.has(word), word);
  }
  // classifyDiagnosticError's own words.
  const logger = readFileSync(join(ROOT, "services/logger.ts"), "utf8");
  const classify = logger.match(/export function classifyDiagnosticError[\s\S]*?\n}/)?.[0] || "";
  const returned = [...classify.matchAll(/return "([a-z_]+)"/g)].map(match => match[1]!);
  assert.ok(returned.length >= 10);
  for (const word of returned) assert.ok(CLOSED_TEXT_VALUES.errorCategory!.has(word), word);
});

test("D170: the log page reads only keys the logger keeps, and no dead alignment title", () => {
  const page = readFileSync(join(ROOT, "pages/DiagnosticLogPage.tsx"), "utf8");
  const read = new Set([...page.matchAll(/\bdetails\??\.([A-Za-z0-9_]+)/g)].map(match => match[1]!));
  assert.ok(read.size > 50);
  assert.deepEqual([...read].filter(key => !DIAGNOSTIC_DETAIL_KEYS.has(key)), []);
  assert.doesNotMatch(page, /已签收冻结，不强刷/, "no alignment flow is written for a signed-frozen row");
});

test("D226, D175, D201: the page reads the folded cloud count, the account code and more reason keys", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const page = readFileSync(join(ROOT, "pages/DiagnosticLogPage.tsx"), "utf8");
  const source = ["legacyBool", "bindingsCount", "providerText", "reasonText", "errorText", "stageText",
    "timelineProviderText", "failureText", "recognitionParts", "phaseParts", "candidateParts", "resultText", "detailsText"]
    .map((name) => {
      const match = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
      assert.ok(match, name);
      return stripTypeScriptTypes(match);
    }).join("\n");
  const detailsText = new Function(`${source}; return detailsText;`)() as
    (item: { event: string; details: Record<string, unknown> }) => string;
  const refresh = detailsText({ event: "refresh.succeeded", details: { cloudPddRecords: 2, cloudPddChanged: false } });
  assert.ok(refresh.includes("拼多多云记录 2 条") && refresh.includes("拼多多云记录无变化"), refresh);
  const account = detailsText({ event: "account.sync.failed", details: {
    failureCode: "account_list_rejected", workerError: "upstream_unavailable", httpStatus: 502 } });
  assert.ok(account.includes("代码 账号列表接口返回业务错误") && account.includes("Worker 代码 upstream_unavailable"), account);
  assert.ok(detailsText({ event: "account.sync.failed", details: {
    failureCode: "account_list_rejected", workerError: "unauthorized", httpStatus: 401 } }).includes("Access Key 不可用"));
  const projection = detailsText({ event: "order.projection.empty", details: {
    historyProvider: "interface5", jdPage: "jd_login", projectionReason: "timeline_reopen", riskControlSeen: true,
    hasPickup: false, structuredStatus: true, latestTrackSemantic: "TRANSIT" } });
  for (const part of ["历史来源 v5_query", "京东页面 登录页", "打开原因 补轨迹", "遇到风控", "无揽收节点", "状态为结构化状态",
    "最新节点状态 TRANSIT"]) assert.ok(projection.includes(part), `${part}: ${projection}`);
});
