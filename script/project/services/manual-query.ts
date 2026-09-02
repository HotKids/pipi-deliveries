import type {
  AccountBinding,
  BindingSource,
  PendingManualQuery,
  Shipment,
} from "../models";
import {
  SCRIPT_CLIENT_BUILD,
  SCRIPT_VERSION,
} from "./build-track";
import { requireScriptSource } from "./script-source";
import { postGateway } from "./gateway";
import {
  manualTimelineIsComplete,
  normalizeWaybill,
  timedTracks,
  waybillSuffix,
} from "./status";
import {
  assertWithinDeadline,
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  kuaidi100PhoneRejected,
  parseKdniaoTimeline,
  parseKuaidi100Timeline,
  parseMeizuTimeline,
  parseMotoTimeline,
  rejectKuaidi100Response,
  type JsonObject,
  type ParsedManualTimeline,
} from "./manual-query-parser";
import {
  applyManualShipment,
  hasTimelineStartBeforeKdniao,
} from "./shipment-policy";
import {
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierKuaidi100Code,
  resolveCarrierQuery,
  queryPhoneTails,
  type CarrierQueryRecord,
} from "./carrier-query";
import { projectedCarrierPresentation } from "./carrier-presentation";
import {
  hasPersistentTracking,
  queryManualSourceChain,
} from "./manual-query-order";
import { recognizeNonSyncCarrier } from "./carrier-recognition";
import {
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  writeDiagnostic,
} from "./logger";
import { queryKuaidi100JdTimeline } from "./kuaidi100-h5";
import {
  recordRefreshProviderResult,
  refreshProviderDue,
  type RefreshProvider,
  type RefreshProviderResult,
} from "./refresh-runtime-state";

class ManualQueryError extends Error {
  constructor(
    message: string,
    readonly needsPhoneTail = false,
    readonly code = "",
  ) {
    super(message);
    this.name = "ManualQueryError";
  }
}

function phoneTailFailure(error: unknown): error is ManualQueryError {
  return error instanceof ManualQueryError && error.needsPhoneTail;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function decodedJsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    try {
      return jsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return jsonObject(value);
}

const MEIZU_IDENTITY_MAX_DEPTH = 12;

function decodedJsonContainer(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.trim();
  const structured = (
    candidate.startsWith("{") && candidate.endsWith("}")
  ) || (
    candidate.startsWith("[") && candidate.endsWith("]")
  );
  if (!structured) return value;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return value;
  }
}

function collectMeizuWaybillIdentities(
  raw: unknown,
  identities: Set<string>,
  depth = 0,
): void {
  if (raw == null || depth > MEIZU_IDENTITY_MAX_DEPTH) return;
  const decoded = decodedJsonContainer(raw);
  if (Array.isArray(decoded)) {
    for (const value of decoded) {
      collectMeizuWaybillIdentities(value, identities, depth + 1);
    }
    return;
  }
  if (!decoded || typeof decoded !== "object") return;
  const object = decoded as JsonObject;
  for (const field of ["nu", "mailNo"]) {
    const value = object[field];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const identity = normalizeWaybill(String(value));
    if (identity) identities.add(identity);
  }
  for (const value of Object.values(object)) {
    collectMeizuWaybillIdentities(value, identities, depth + 1);
  }
}

function firstText(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

function canonicalCarrierIdentity(value: string): string {
  const code = String(value || "").trim();
  if (!code) return "";
  return (
    resolveCarrierQuery(code) ||
    resolveCarrierCpCode(code) ||
    resolveCarrierKuaidi100Code(code)
  )?.standardCode || normalizeCarrierCode(code);
}

type ManualGatewayPost = (
  route: string,
  payload: Record<string, unknown>,
  options?: {
    timeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
  },
) => Promise<JsonObject>;

export type ManualSourceDependencies = Readonly<{
  post?: ManualGatewayPost;
  now?: () => number;
  queryKuaidi100JdTimeline?: typeof queryKuaidi100JdTimeline;
}>;

function sourcePost(dependencies?: ManualSourceDependencies): ManualGatewayPost {
  return dependencies?.post || ((route, payload, options) =>
    postGateway<JsonObject>(route, payload, options));
}

function sourceNow(dependencies?: ManualSourceDependencies): number {
  return (dependencies?.now || Date.now)();
}

function responseCode(root: JsonObject): number | null {
  const value = root.code;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const candidate = text(value);
  return /^-?\d+$/.test(candidate) ? Number(candidate) : null;
}

function uniquePhoneTails(
  explicitTail: string,
  boundTails: readonly string[],
  includeEmpty: boolean,
): string[] {
  return [includeEmpty ? "" : explicitTail, explicitTail, ...boundTails]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) =>
      (value === "" || /^\d{4}$/.test(value)) && values.indexOf(value) === index
    );
}

export type ManualCarrierDetection = {
  courierCode: string;
  companyName: string;
  requiresPhoneTail: boolean;
};

export type ManualCarrierDetector = (
  waybill: string,
  options?: Readonly<{ deadlineAtMs?: number; signal?: AbortSignal }>,
) => Promise<ManualCarrierDetection | null>;

export async function detectManualCarrier(
  waybillInput: string,
  options: Readonly<{ deadlineAtMs?: number; signal?: AbortSignal }> = {},
): Promise<ManualCarrierDetection | null> {
  const waybill = normalizeWaybill(waybillInput);
  if (waybill.length < 6) return null;

  const recognition = await recognizeNonSyncCarrier(waybill, {
    deadlineAtMs: options.deadlineAtMs,
    signal: options.signal,
  });
  const carrier = recognition.normalization
    ? resolveCarrierQuery(recognition.normalization.standardCode)
    : null;
  if (!carrier) return null;
  const presentation = projectedCarrierPresentation(
    waybill,
    carrier.standardCode,
    recognition.normalization?.displayName || carrier.displayName,
  );
  if (!presentation.companyName || presentation.companyName === "快递") {
    return null;
  }
  return {
    courierCode: presentation.courierCode || carrier.standardCode,
    companyName: presentation.companyName,
    requiresPhoneTail: carrier?.requiresPhoneTail || false,
  };
}

export class ManualCarrierDetectionCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<ManualCarrierDetection | null>
  >();
  private lastResolved: Readonly<{
    waybill: string;
    value: ManualCarrierDetection;
  }> | null = null;

  constructor(private readonly detect: ManualCarrierDetector = detectManualCarrier) {}

  resolve(
    waybillInput: string,
    options: Readonly<{ deadlineAtMs?: number; signal?: AbortSignal }> = {},
  ): Promise<ManualCarrierDetection | null> {
    const waybill = normalizeWaybill(waybillInput);
    if (waybill.length < 6) return Promise.resolve(null);
    if (this.lastResolved?.waybill === waybill) {
      return Promise.resolve(this.lastResolved.value);
    }
    const existing = this.inFlight.get(waybill);
    if (existing) return existing;
    const task = this.detect(waybill, options)
      .then((value) => {
        if (value) this.lastResolved = { waybill, value };
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(waybill) === task) this.inFlight.delete(waybill);
      });
    this.inFlight.set(waybill, task);
    return task;
  }
}

export async function refreshPendingCarrierPresentation(
  pending: PendingManualQuery,
  options: Readonly<{
    deadlineAtMs?: number;
    signal?: AbortSignal;
    detect?: ManualCarrierDetector;
  }> = {},
): Promise<PendingManualQuery> {
  try {
    const presentation = await (options.detect || detectManualCarrier)(
      pending.waybill,
      { deadlineAtMs: options.deadlineAtMs, signal: options.signal },
    );
    if (!presentation) return pending;
    const recognizedCarrier = resolveCarrierQuery(presentation.courierCode);
    return {
      ...pending,
      courierCode: presentation.courierCode,
      rawCourierCode:
        pending.rawCourierCode || recognizedCarrier?.standardCode || "",
      companyName: presentation.companyName,
    };
  } catch (error) {
    if (error instanceof OperationTimeoutError || options.signal?.aborted) {
      throw new OperationTimeoutError();
    }
    return pending;
  }
}

function shipmentFromTimeline(input: {
  waybill: string;
  phoneTail: string;
  rawCourierCode: string;
  providerRawCourierCode?: string;
  courierCode: string;
  companyName: string;
  bindingSource: BindingSource | null;
  provider: string;
  complete: boolean;
  parsed: ParsedManualTimeline;
  successAtMs?: number;
}): Shipment {
  const now = input.successAtMs ?? Date.now();
  const timeline = {
    provider: input.provider,
    complete: input.complete,
    structuredStatus: input.parsed.hasStructuredStatus,
    waybill: input.waybill,
    ...(input.providerRawCourierCode
      ? { rawCourierCode: input.providerRawCourierCode }
      : {}),
    courierCode: input.courierCode,
    companyName: input.companyName,
    semantic: input.parsed.semantic,
    statusEventAtMs: input.parsed.statusEventAtMs,
    latestTimeText: input.parsed.latestTimeText,
    latestDetail: input.parsed.latestDetail,
    tracks: input.parsed.tracks,
    successAtMs: now,
  } satisfies Shipment["timeline"];
  return {
    identity: {
      id: `${input.bindingSource || "legacy"}:manual:${input.waybill}`,
      bindingSource: input.bindingSource,
      sourceOwner: "manual",
      sourceId: input.waybill,
      phoneTail: input.phoneTail,
      courierCode: input.courierCode,
      rawCourierCode: input.rawCourierCode,
      companyName: input.companyName,
      manuallyAdded: true,
      createdAtMs: now,
    },
    timeline,
    sourceTimeline: null,
    manualTimelines: [timeline],
    updatedAtMs: now,
  };
}

async function queryCandidate(
  waybill: string,
  phoneTail: string,
  protocolCode: string,
  rawCourierCode: string,
  companyNameHint: string,
  bindingSource: BindingSource | null,
  deadlineAtMs?: number,
  signal?: AbortSignal,
  dependencies?: ManualSourceDependencies,
): Promise<Shipment> {
  assertWithinDeadline(deadlineAtMs);
  const root = await sourcePost(dependencies)("/api/express/timeline/preferred", {
    waybill,
    companyCode: protocolCode,
    phone: phoneTail,
  }, {
    timeoutMs: remainingTimeoutMs(deadlineAtMs, 30_000),
    deadlineAtMs,
    signal,
  });
  const phoneRejected = kuaidi100PhoneRejected(root);
  if (rejectKuaidi100Response(root)) {
    if (phoneRejected) {
      throw new ManualQueryError(
        phoneTail ? "手机尾号不正确，请重新输入" : "请输入 4 位手机尾号",
        true,
      );
    }
    throw new ManualQueryError(
      "查询失败，请稍后重试",
      false,
      "upstream_rejected",
    );
  }
  const parsed = parseKuaidi100Timeline(root);
  const providerRawCourierCode = firstText(
    root,
    "companyCode",
    "comCode",
    "com",
  );
  const returnedCode = providerRawCourierCode || rawCourierCode;
  const returnedCarrier = resolveCarrierKuaidi100Code(returnedCode);
  const resolvedCode = returnedCarrier?.standardCode || returnedCode;
  const companyName = firstText(root, "companyName", "comName") ||
    companyNameHint || returnedCarrier?.displayName || resolvedCode;
  return shipmentFromTimeline({
    waybill,
    phoneTail,
    rawCourierCode: returnedCode,
    providerRawCourierCode,
    courierCode: resolvedCode,
    companyName,
    bindingSource,
    provider: "kuaidi100",
    complete: true,
    parsed,
    successAtMs: sourceNow(dependencies),
  });
}

async function queryCarrierCandidate(
  waybill: string,
  rawCourierCode: string,
  protocolCode: string,
  companyNameHint: string,
  bindingSource: BindingSource | null,
  explicitTail: string,
  boundTails: readonly string[],
  deadlineAtMs?: number,
  signal?: AbortSignal,
  dependencies?: ManualSourceDependencies,
): Promise<Shipment> {
  const carrier = resolveCarrierCpCode(rawCourierCode);
  const tails = queryPhoneTails(carrier, explicitTail, boundTails);
  if (carrier?.requiresPhoneTail && !tails.length) {
    throw new ManualQueryError("请输入 4 位手机尾号", true);
  }

  let lastError: unknown = null;
  const firstTail = carrier?.requiresPhoneTail ? null : tails[0] || "";
  if (firstTail != null) {
    try {
      return await queryCandidate(
        waybill,
        firstTail,
        protocolCode,
        rawCourierCode,
        companyNameHint,
        bindingSource,
        deadlineAtMs,
        signal,
        dependencies,
      );
    } catch (error) {
      if (!phoneTailFailure(error)) throw error;
      lastError = error;
    }
  }

  const suppliedTails = carrier?.requiresPhoneTail ? tails : tails.slice(1);
  if (!suppliedTails.length) {
    throw lastError instanceof Error
      ? lastError
      : new ManualQueryError("请输入 4 位手机尾号", true);
  }
  for (const phoneTail of suppliedTails) {
    assertWithinDeadline(deadlineAtMs);
    try {
      return await queryCandidate(
        waybill,
        phoneTail,
        protocolCode,
        rawCourierCode,
        companyNameHint,
        bindingSource,
        deadlineAtMs,
        signal,
        dependencies,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ManualQueryError("请输入 4 位手机尾号", true);
}

export async function queryKuaidi100Shipment(input: {
  waybill: string;
  phoneTail?: string;
  rawCourierCode?: string;
  courierCode?: string;
  companyName?: string;
  bindingSource?: BindingSource | null;
  phoneTails?: readonly string[];
  deadlineAtMs?: number;
  signal?: AbortSignal;
  dependencies?: ManualSourceDependencies;
}): Promise<Shipment> {
  const waybill = normalizeWaybill(input.waybill);
  if (waybill.length < 6) throw new Error("请输入有效的快递单号");
  const explicitTail = String(input.phoneTail || "").trim();
  const boundTails: string[] = [];
  for (const candidate of input.phoneTails || []) {
    const tail = String(candidate || "").trim();
    if (!tail) continue;
    if (!/^\d{4}$/.test(tail)) throw new Error("请输入 4 位手机尾号");
    if (!boundTails.includes(tail)) boundTails.push(tail);
  }
  if (explicitTail && !/^\d{4}$/.test(explicitTail)) {
    throw new Error("请输入 4 位手机尾号");
  }
  // Carrier recognition is display-only. Only a raw carrier supplied by the
  // shipment/source may become an upstream timeline query parameter.
  const rawCourierCode = String(input.rawCourierCode || "").trim();
  const rawCarrier = resolveCarrierCpCode(rawCourierCode);
  if (!rawCarrier) {
    throw new ManualQueryError(
      "K100 查询缺少原始承运商代码",
      false,
      "invalid_company_code",
    );
  }
  const protocolCode = rawCarrier?.kuaidi100Code || "";
  return queryCarrierCandidate(
    waybill,
    rawCourierCode,
    protocolCode,
    String(input.companyName || "").trim(),
    input.bindingSource || null,
    explicitTail,
    boundTails,
    input.deadlineAtMs,
    input.signal,
    input.dependencies,
  );
}

type ManualSourceShipmentInput = Readonly<{
  waybill: string;
  phoneTail?: string;
  phoneTails?: readonly string[];
  rawCourierCode?: string;
  courierCode?: string;
  companyName?: string;
  bindingSource?: BindingSource | null;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  dependencies?: ManualSourceDependencies;
  resolvedCarrier?: CarrierQueryRecord | null;
}>;

function manualInputCarrier(
  input: ManualSourceShipmentInput,
): CarrierQueryRecord | null {
  if (input.resolvedCarrier) return input.resolvedCarrier;
  const rawCode = String(input.rawCourierCode || "").trim();
  return rawCode
    ? resolveCarrierCpCode(rawCode)
    : resolveCarrierQuery(String(input.courierCode || ""));
}

function sourceIdentity(
  rawCode: string,
  responseCode: string,
  responseName: string,
  nameHint: string,
  fallbackCarrier: CarrierQueryRecord | null = null,
): {
  rawCourierCode: string;
  providerRawCourierCode: string;
  courierCode: string;
  companyName: string;
} {
  const returned = resolveCarrierCpCode(responseCode);
  const raw = fallbackCarrier || resolveCarrierCpCode(rawCode);
  const carrier = returned || raw;
  const courierCode = carrier?.standardCode || responseCode || rawCode;
  return {
    rawCourierCode: responseCode || rawCode,
    providerRawCourierCode: responseCode,
    courierCode,
    companyName: responseName || carrier?.displayName || nameHint || courierCode,
  };
}

export async function queryMotoShipment(
  input: ManualSourceShipmentInput,
): Promise<Shipment> {
  const waybill = normalizeWaybill(input.waybill);
  const rawCourierCode = String(
    input.rawCourierCode || input.courierCode || "",
  ).trim();
  const carrier = resolveCarrierCpCode(rawCourierCode);
  if (!rawCourierCode || !carrier) {
    throw new ManualQueryError(
      "本地轨迹查询缺少原始承运商代码",
      false,
      "invalid_company_code",
    );
  }
  if (carrier.standardCode === "SF") {
    throw new ManualQueryError(
      "公开物流查询暂无轨迹",
      false,
      "unsupported_company_code",
    );
  }
  assertWithinDeadline(input.deadlineAtMs);
  const root = await sourcePost(input.dependencies)(
    "/api/express/timeline/public",
    { waybill, companyCode: rawCourierCode },
    {
      timeoutMs: remainingTimeoutMs(input.deadlineAtMs, 30_000),
      deadlineAtMs: input.deadlineAtMs,
      signal: input.signal,
    },
  );
  const data = jsonObject(root.data);
  if (String(root.status ?? "").trim() !== "0" || !Object.keys(data).length) {
    throw new ManualQueryError(
      "本地轨迹查询失败",
      false,
      "upstream_rejected",
    );
  }
  const identity = sourceIdentity(
    rawCourierCode,
    firstText(data, "cpCode"),
    firstText(data, "cpName"),
    String(input.companyName || ""),
    carrier,
  );
  return shipmentFromTimeline({
    waybill,
    phoneTail: "",
    ...identity,
    bindingSource: input.bindingSource || null,
    provider: "local",
    complete: false,
    parsed: parseMotoTimeline(root),
    successAtMs: sourceNow(input.dependencies),
  });
}

function trustedMeizuDetailUrl(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (
      host === "kuaidi100.com" || host.endsWith(".kuaidi100.com")
    ) ? candidate : "";
  } catch {
    return "";
  }
}

async function queryMeizuShipmentOnce(
  input: ManualSourceShipmentInput,
): Promise<{ shipment: Shipment; routeUrl: string }> {
  const waybill = normalizeWaybill(input.waybill);
  assertWithinDeadline(input.deadlineAtMs);
  const root = await sourcePost(input.dependencies)(
    "/api/express/timeline/source",
    {
      interface: "v6",
      mode: "manual",
      waybill,
      clientVersion: SCRIPT_VERSION,
      clientBuild: SCRIPT_CLIENT_BUILD,
    },
    {
      timeoutMs: remainingTimeoutMs(input.deadlineAtMs, 30_000),
      deadlineAtMs: input.deadlineAtMs,
      signal: input.signal,
    },
  );
  const code = responseCode(root);
  if (code != null && code !== 0 && code !== 200) {
    throw new ManualQueryError(
      "路由轨迹查询失败",
      false,
      "upstream_rejected",
    );
  }
  const value = decodedJsonObject(root.value ?? root.data ?? root);
  if (!Object.keys(value).length) {
    throw new ManualQueryError("路由轨迹暂无数据", false, "no_result");
  }
  const returnedWaybills = new Set<string>();
  collectMeizuWaybillIdentities(root, returnedWaybills);
  if ([...returnedWaybills].some((returned) => returned !== waybill)) {
    throw new ManualQueryError(
      "路由轨迹返回的运单与查询不一致",
      false,
      "invalid_upstream_response",
    );
  }
  const identity = sourceIdentity(
    String(input.rawCourierCode || ""),
    firstText(value, "com", "cpCode"),
    firstText(value, "name", "cpName"),
    String(input.companyName || ""),
    manualInputCarrier(input),
  );
  const shipment = shipmentFromTimeline({
    waybill,
    phoneTail: "",
    ...identity,
    bindingSource: input.bindingSource || null,
    provider: "route",
    complete: false,
    parsed: parseMeizuTimeline(value),
    successAtMs: sourceNow(input.dependencies),
  });
  return {
    shipment,
    routeUrl: trustedMeizuDetailUrl(firstText(value, "detailUrl", "url")),
  };
}

export async function queryMeizuShipment(
  input: ManualSourceShipmentInput,
): Promise<{ shipment: Shipment; routeUrl: string }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await queryMeizuShipmentOnce(input);
    } catch (error) {
      lastError = error;
      const retriable = error instanceof ManualQueryError &&
        (error.code === "upstream_rejected" || error.code === "no_result");
      if (!retriable || attempt > 0) throw error;
      assertWithinDeadline(input.deadlineAtMs);
    }
  }
  throw lastError;
}

async function queryJingDongKuaidi100Shipment(
  input: ManualSourceShipmentInput,
): Promise<{ shipment: Shipment | null; skipReason?: string }> {
  const waybill = normalizeWaybill(input.waybill);
  const phoneTail = String(input.phoneTail || "").trim();
  const carrier = manualInputCarrier(input);
  const query = input.dependencies?.queryKuaidi100JdTimeline ||
    queryKuaidi100JdTimeline;
  const timeline = await query({
    waybill,
    phoneTail,
    courierCode: carrier?.standardCode || "JD",
    companyName: String(input.companyName || "").trim() ||
      carrier?.displayName || "京东快递",
    deadlineAtMs: input.deadlineAtMs,
    signal: input.signal,
  });
  if (!timeline) return { shipment: null, skipReason: "no_timed_tracks" };
  const now = timeline.successAtMs;
  return {
    shipment: {
      identity: {
        id: `${input.bindingSource || "legacy"}:manual:${waybill}`,
        bindingSource: input.bindingSource || null,
        sourceOwner: "manual",
        sourceId: waybill,
        phoneTail,
        courierCode: timeline.courierCode,
        rawCourierCode: String(input.rawCourierCode || "").trim() || "JD",
        companyName: timeline.companyName,
        manuallyAdded: true,
        createdAtMs: now,
      },
      timeline,
      sourceTimeline: null,
      manualTimelines: [timeline],
      updatedAtMs: now,
    },
  };
}

export async function queryKdniaoShipment(
  input: ManualSourceShipmentInput,
): Promise<Shipment> {
  const waybill = normalizeWaybill(input.waybill);
  const carrier = manualInputCarrier(input);
  if (!carrier) {
    throw new ManualQueryError(
      "快递鸟缺少原始承运商代码",
      false,
      "invalid_company_code",
    );
  }
  const explicitTail = String(input.phoneTail || "").trim();
  const tails = carrier.requiresPhoneTail
    ? queryPhoneTails(carrier, explicitTail, input.phoneTails || [])
    : [""];
  if (!tails.length) throw new ManualQueryError("请输入 4 位手机尾号", true);
  let lastPhoneError: ManualQueryError | null = null;
  for (const phoneTail of tails) {
    assertWithinDeadline(input.deadlineAtMs);
    const root = await sourcePost(input.dependencies)(
      "/api/express/timeline/fallback",
      {
        waybill,
        shipperCode: carrier.standardCode,
        phone: carrier.requiresPhoneTail ? phoneTail : "",
      },
      {
        timeoutMs: remainingTimeoutMs(input.deadlineAtMs, 30_000),
        deadlineAtMs: input.deadlineAtMs,
        signal: input.signal,
      },
    );
    if (root.success !== true) {
      const reason = firstText(root, "reason", "message", "msg");
      if (/手机|电话|尾号|phone/i.test(reason)) {
        lastPhoneError = new ManualQueryError(
          phoneTail ? "手机尾号不正确，请重新输入" : "请输入 4 位手机尾号",
          true,
        );
        continue;
      }
      throw new ManualQueryError(
        "快递鸟查询失败",
        false,
        "upstream_rejected",
      );
    }
    const returnedWaybill = normalizeWaybill(firstText(root, "logisticCode"));
    const returnedShipperCode = firstText(root, "shipperCode");
    if (
      !returnedWaybill ||
      returnedWaybill !== waybill ||
      !returnedShipperCode ||
      canonicalCarrierIdentity(returnedShipperCode) !==
        canonicalCarrierIdentity(carrier.standardCode)
    ) {
      throw new ManualQueryError(
        "快递鸟返回身份与查询不一致",
        false,
        "invalid_upstream_response",
      );
    }
    const source = sourceIdentity(
      String(input.rawCourierCode || ""),
      firstText(root, "shipperCode"),
      firstText(root, "companyName"),
      String(input.companyName || ""),
      carrier,
    );
    return shipmentFromTimeline({
      waybill,
      phoneTail: carrier.requiresPhoneTail ? phoneTail : "",
      ...source,
      bindingSource: input.bindingSource || null,
      provider: "fallback",
      complete: true,
      parsed: parseKdniaoTimeline(root),
      successAtMs: sourceNow(input.dependencies),
    });
  }
  throw lastPhoneError || new ManualQueryError("请输入 4 位手机尾号", true);
}

export type ManualQueryOutcome = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
};

export const SCRIPT_MANUAL_SOURCE_ACTIVATION = {
  local: true,
  route: true,
  fallback: true,
} as const;

function diagnosticManualProvider(value: unknown): string {
  const provider = String(value || "").trim().toLowerCase();
  return ({
    local: "moto",
    route: "meizu",
    fallback: "kdniao",
  } as Record<string, string>)[provider] || provider || "none";
}

export function allowsRouteCapabilityForSourceProvider(
  sourceProvider: unknown,
): boolean {
  const provider = String(sourceProvider || "").trim().toLowerCase();
  return !provider || provider === "shunfeng";
}

export function allowsLocalCapabilityForSourceProvider(
  sourceProvider: unknown,
): boolean {
  const provider = String(sourceProvider || "").trim().toLowerCase();
  return !provider || provider === "cainiao";
}

export async function queryManualForSource(input: {
  source: BindingSource;
  bindings: readonly AccountBinding[];
  waybill: string;
  phoneTail?: string;
  rawCourierCode?: string;
  courierCode?: string;
  companyName?: string;
  sourceProvider?: string;
  presentation?: ManualCarrierDetection | null;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  includeKdniaoFallback?: boolean;
  fallbackOnly?: boolean;
  pickerOnly?: boolean;
  motoOnly?: boolean;
  currentShipment?: Shipment;
  pickerFirst?: boolean;
  scheduled?: boolean;
  hostSafe?: boolean;
  dependencies?: ManualSourceDependencies;
  diagnosticFlowId?: string;
  diagnosticStage?: string;
}): Promise<ManualQueryOutcome> {
  requireScriptSource(input.source);
  const waybill = normalizeWaybill(input.waybill);
  if (waybill.length < 6) throw new Error("请输入有效的快递单号");
  const phoneTail = String(input.phoneTail || "").trim();
  if (phoneTail && !/^\d{4}$/.test(phoneTail)) {
    throw new Error("请输入 4 位手机尾号");
  }

  const phoneTails = input.bindings.map((binding) => binding.phone.slice(-4));
  const sourceCarrierCode = String(input.rawCourierCode || "").trim();
  const recognizedCarrier = sourceCarrierCode
    ? null
    : resolveCarrierQuery(String(input.presentation?.courierCode || ""));
  // A first manual query has no source-owned carrier code yet. The detection result is
  // safe for dispatch only after it resolves back to an exact built-in carrier record.
  const rawCarrierCode = sourceCarrierCode || recognizedCarrier?.standardCode || "";
  const resolvedRawCarrier = sourceCarrierCode
    ? resolveCarrierCpCode(sourceCarrierCode)
    : recognizedCarrier;
  // Source routing and raw carrier normalization are separate authorities. A
  // Cainiao parcel carried by JD still uses Moto; only a JingDong-owned parcel
  // bypasses it for the K100 route.
  const isJingDongSource =
    String(input.sourceProvider || "").trim().toLowerCase() === "jingdong";
  const queryInput: ManualSourceShipmentInput = {
    waybill,
    phoneTail,
    phoneTails,
    rawCourierCode: rawCarrierCode,
    courierCode: input.presentation?.courierCode || input.courierCode,
    companyName: input.presentation?.companyName || input.companyName,
    bindingSource: input.source,
    deadlineAtMs: input.deadlineAtMs,
    signal: input.signal,
    dependencies: input.dependencies,
    resolvedCarrier: resolvedRawCarrier,
  };
  const diagnosticFlowId = input.diagnosticFlowId ||
    createDiagnosticFlowId("manual-query");
  const queryStartedAt = Date.now();
  const waybillTail = waybillSuffix(waybill);
  const routeTimelineProvider = isJingDongSource
    && !input.pickerOnly
    ? "kuaidi100_h5"
    : "meizu";
  const scheduleKey = `${input.source}:${waybill}`;
  const identityFingerprint = [
    rawCarrierCode,
    phoneTail,
    String(input.sourceProvider || "").trim().toLowerCase(),
  ].join(":");
  const scheduledProvider = (source: "local" | "route" | "fallback"):
    RefreshProvider => source === "local"
      ? "moto"
      : source === "fallback"
        ? "kdniao"
        : isJingDongSource ? "kuaidi100" : "picker";
  const providerEnabled = (source: "local" | "route" | "fallback") =>
    !input.scheduled || refreshProviderDue(
      scheduleKey,
      scheduledProvider(source),
      identityFingerprint,
    );

  const hasTimed = (shipment: Shipment | null): boolean =>
    Boolean(shipment && timedTracks(shipment.timeline.tracks).length);
  const selection = await queryManualSourceChain([
    {
      source: "local",
      enabled: SCRIPT_MANUAL_SOURCE_ACTIVATION.local &&
        providerEnabled("local") &&
        !input.fallbackOnly &&
        !input.pickerOnly &&
        !isJingDongSource &&
        (input.motoOnly === true ||
          allowsLocalCapabilityForSourceProvider(input.sourceProvider)),
      query: async () => ({ shipment: await queryMotoShipment(queryInput) }),
    },
    {
      source: "route",
      enabled: SCRIPT_MANUAL_SOURCE_ACTIVATION.route &&
        providerEnabled("route") &&
        !input.fallbackOnly &&
        !input.motoOnly &&
        !(input.hostSafe && isJingDongSource) &&
        (input.pickerOnly === true || isJingDongSource ||
          allowsRouteCapabilityForSourceProvider(input.sourceProvider)),
      query: async () => isJingDongSource && !input.pickerOnly
        ? queryJingDongKuaidi100Shipment(queryInput)
        : queryMeizuShipment(queryInput),
    },
    {
      source: "fallback",
      enabled: SCRIPT_MANUAL_SOURCE_ACTIVATION.fallback &&
        providerEnabled("fallback") &&
        input.includeKdniaoFallback === true,
      query: async () => ({ shipment: await queryKdniaoShipment(queryInput) }),
    },
  ], input.deadlineAtMs, (observation) => {
    const stage = observation.source;
    const timelineProvider = observation.result?.shipment?.timeline.provider
      ? diagnosticManualProvider(observation.result.shipment.timeline.provider)
      : stage === "route"
        ? routeTimelineProvider
        : diagnosticManualProvider(stage);
    if (observation.phase === "started") {
      writeDiagnostic("manual.source.started", {
        flowId: diagnosticFlowId,
        source: input.source,
        stage,
        waybillTail,
        timelineProvider,
      });
      return;
    }
    if (observation.error) {
      if (input.scheduled) {
        const details = diagnosticErrorDetails(observation.error);
        const failure = String(details.failureCode || details.errorCategory || "");
        const result: RefreshProviderResult = failure === "invalid_query" ||
            failure === "phone_tail"
          ? "invalid_query"
          : failure === "upstream_rejected" || failure === "upstream"
            ? "upstream_rejected"
            : failure === "timeout"
              ? "timeout"
              : failure === "network"
                ? "network"
                : "failed";
        recordRefreshProviderResult({
          key: scheduleKey,
          provider: scheduledProvider(observation.source),
          identityFingerprint,
          result,
        });
      }
      writeDiagnostic("manual.source.failed", {
        flowId: diagnosticFlowId,
        source: input.source,
        stage,
        waybillTail,
        timelineProvider,
        durationMs: observation.durationMs,
        ...diagnosticErrorDetails(observation.error),
      }, "warning");
      return;
    }
    const timeline = observation.result?.shipment?.timeline || null;
    const trackCount = timeline ? timedTracks(timeline.tracks).length : 0;
    const skipReason = observation.result?.skipReason || "no_timed_tracks";
    if (input.scheduled) {
      recordRefreshProviderResult({
        key: scheduleKey,
        provider: scheduledProvider(observation.source),
        identityFingerprint,
        result: trackCount ? "success" : "no_result",
      });
    }
    writeDiagnostic(
      trackCount ? "manual.source.succeeded" : "manual.source.skipped",
      {
        flowId: diagnosticFlowId,
        source: input.source,
        stage,
        waybillTail,
        timelineProvider,
        durationMs: observation.durationMs,
        effectiveTrackCount: trackCount,
        result: trackCount
          ? manualTimelineIsComplete(timeline!) ? "complete" : "partial"
          : skipReason,
      },
      trackCount || skipReason === "unsupported_carrier" ? "info" : "warning",
    );
  }, input.signal, (shipments) => {
    let accumulated = input.currentShipment;
    for (const shipment of shipments) {
      accumulated = applyManualShipment(accumulated, shipment, Date.now());
    }
    return Boolean(
      accumulated && hasTimelineStartBeforeKdniao(accumulated),
    );
  }, Boolean(input.pickerFirst));
  const {
    selected: selectedResult,
    selectedRouteUrl,
    successes,
    errors,
  } = selection;
  const selected = selectedResult
    ? {
        ...selectedResult,
        route: selectedRouteUrl
          ? { kind: "web" as const, source: input.source }
          : selectedResult.route,
        manualTimelines: successes.map((shipment) => shipment.timeline),
      }
    : null;
  const selectedTrackCount = selected
    ? timedTracks(selected.timeline.tracks).length
    : 0;
  writeDiagnostic("manual.query.completed", {
    flowId: diagnosticFlowId,
    source: input.source,
    stage: input.diagnosticStage || "manual_query",
    waybillTail,
    timelineProvider: selectedTrackCount
      ? diagnosticManualProvider(selected?.timeline.provider)
      : "none",
    effectiveTrackCount: selectedTrackCount,
    records: successes.length,
    selected: Boolean(selectedTrackCount),
    durationMs: Date.now() - queryStartedAt,
    result: selectedTrackCount
      ? manualTimelineIsComplete(selected!.timeline) ? "complete" : "partial"
      : "no_result",
  }, selectedTrackCount ? "info" : "warning");
  const phoneError = !selected
    ? Object.values(errors).find(
        (error) =>
          error instanceof Error && error.message.includes("手机尾号"),
      )
    : null;
  if (phoneError instanceof Error) throw phoneError;
  if (selected && hasTimed(selected)) {
    return { shipment: selected, pending: null, routeUrl: selectedRouteUrl };
  }
  const now = Date.now();
  const pending: PendingManualQuery = {
    id: `${input.source}:${waybill}`,
    source: input.source,
    waybill,
    phoneTail,
    courierCode:
      selected?.identity.courierCode ||
      input.presentation?.courierCode ||
      input.courierCode ||
      "",
    rawCourierCode:
      selected?.identity.rawCourierCode ||
      rawCarrierCode ||
      "",
    companyName:
      selected?.identity.companyName ||
      input.presentation?.companyName ||
      input.companyName ||
      "",
    createdAtMs: now,
    lastAttemptAtMs: now,
    attempts: 1,
    route: selected?.route || (selectedRouteUrl
      ? { kind: "web" as const, source: input.source }
      : null),
  };
  return {
    shipment: selected,
    pending,
    routeUrl: selectedRouteUrl,
  };
}
