import { statusProjectionFields } from "./worker-status";
import type { AccountAppTarget } from "./account-app-links";
import { loadAccountAppRoutes, saveAccountAppRoutes } from "./routes";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import type {
  AccountBinding,
  AccountDetailRecord,
  BindingSource,
  Shipment,
  ShipmentRoute,
  StatusSemantic,
  TrackNode,
} from "../models";
import { AccountApi } from "./account-api";
import { loadAccountIdentity } from "./account-identity";
import type { AccountParcelDto } from "./account-parser";
import {
  JING_DONG_ACCOUNT_CP_CODE,
  JING_DONG_ACCOUNT_NAME,
  matchBoundPhone,
  normalizePhoneEvidence,
  parseAccountSyncResult,
  parseAccountTimelineResponse,
} from "./account-parser";
import { GatewayError, postGateway } from "./gateway";
import {
  incomingStatusAdvances,
  mergeTimelinePackage,
  normalizeWaybill,
  normalizedProjectedWaybill,
  parseProviderTime,
  semanticFromAccountState,
  semanticFromStored,
  semanticFromText,
  splitJingDongH5Nodes,
  timedTracks,
  withoutJingDongOrderCompletion,
} from "./status";
import {
  assertWithinDeadline,
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { accountOrderTextIdentity } from "./account-order-text-identity";
import { displayWaybill } from "./shipment-policy";
import {
  accountParcelClassifyAnchor,
  directAccountCarrierPresentation,
  normalizeAccountParcelCarrier,
  type AccountCarrierNormalizationOptions,
} from "./account-carrier-normalization";
import {
  cachedCarrierRecognition,
  CarrierRecognitionBudget,
  carrierRecognitionExhausted,
  recognizeNonSyncCarrier,
  truncatedCarrierRecognitionLast,
} from "./carrier-recognition";
import { activeCarrierTableVersion } from "./carrier-query";
import type { CarrierNormalization } from "./carrier-normalization";

export type AccountParcelFetchResult = Readonly<{
  parcels: readonly AccountParcelDto[];
  rawRecords: number;
  rejectedRecords: number;
}>;

function accountApi(deadlineAtMs?: number, signal?: AbortSignal, onQueryAttempted?: (authorized: boolean) => void,
  beforeQuery?: () => void): AccountApi {
  return new AccountApi((route, payload, timeoutMs) =>
    postGateway(route, payload, {
      timeoutMs: remainingTimeoutMs(deadlineAtMs, timeoutMs),
      deadlineAtMs,
      signal,
      onQueryAttempted,
      beforeQuery,
    }),
  );
}

function phones(bindings: readonly AccountBinding[], source: BindingSource): string[] {
  return bindings
    .filter((binding) => binding.source === source)
    .map((binding) => binding.phone);
}

function recognitionInterrupted(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (error instanceof Error && error.name === "AbortError"));
}

/** Keeps display-only carrier recognition from failing account data retrieval. */
export async function normalizeAccountParcelCarrierBestEffort(
  parcel: AccountParcelDto,
  options: AccountCarrierNormalizationOptions = {},
): Promise<AccountParcelDto> {
  if (options.signal?.aborted) throw new OperationTimeoutError();
  try {
    const normalized = await normalizeAccountParcelCarrier(parcel, options);
    if (options.signal?.aborted) throw new OperationTimeoutError();
    return normalized;
  } catch (error) {
    if (recognitionInterrupted(error, options.signal)) throw error;
    if (
      error instanceof GatewayError ||
      error instanceof OperationTimeoutError
    ) return directAccountCarrierPresentation(parcel);
    throw error;
  }
}

/**
 * The carrier waybill an unprojected order's own feed text names (independent identity extraction,
 * 2026-09-10); "" when the parcel is not such an order or its text names none.
 */
export function accountOrderTextWaybill(parcel: AccountParcelDto): string {
  if (parcel.source !== "interface5" || !parcel.accountOrder ||
      normalizeWaybill(parcel.waybill) !== normalizeWaybill(parcel.ownerId)) return "";
  return (parcel.textIdentity || accountOrderTextIdentity(parcel.tracks))?.waybill || "";
}

function textWaybillWithCarrier(
  parcel: AccountParcelDto,
  waybill: string,
  carrier: Readonly<{ normalization: CarrierNormalization | null; displayName?: string; exhausted?: boolean }>,
): AccountParcelDto {
  const normalization = carrier.normalization?.isBuiltIn ? carrier.normalization : null;
  const displayName = String(carrier.displayName || "").trim();
  if (!normalization && !displayName) {
    // 其余裁决 32、33（用户 2026-09-26）：识别进入终态、快递100 也没给名字——订单不再停在订单阶段，照常投影，承运商位置
    // 填这张订单来源传回的承运商码原样（JDKD 这类，不是平台名），没传回就空着。只作显示，不当承运商码用。
    const rawCode = String(parcel.rawCourierCode || "").trim();
    return carrier.exhausted
      ? { ...parcel, waybill, courierCode: "", companyName: rawCode, carrierNormalization: null }
      : parcel;
  }
  return {
    ...parcel,
    waybill,
    rawCourierCode: "",
    rawCompanyName: "",
    courierCode: normalization ? normalization.standardCode : "",
    companyName: normalization ? normalization.displayName : displayName,
    carrierNormalization: normalization || {
      standardCode: "",
      displayName,
      kuaidi100Code: "",
      isBuiltIn: false,
      tableVersion: activeCarrierTableVersion(),
    },
  };
}

/**
 * Applies the carrier waybill that an unprojected order's own feed text names (independent
 * identity extraction, 2026-09-10). Only the waybill is read (user decision 2026-09-26, 其余裁决 7):
 * the order-stage raw tuple (JDKD / 京东商品快递) and the carrier the sentence names are both no
 * evidence for that waybill, so its carrier comes from recognition like any real waybill.
 *
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：识别链（内置表 → 快递100 → 付费快递鸟）已经为这张运单
 * 给出承运商（识别缓存里有）才把运单号亮出来；还没对上时订单保持原样（仍是「京东购物」那一行），文案每轮随 feed
 * 回来，之后各轮识别出来再投影。
 */
export function withAccountOrderTextWaybill(parcel: AccountParcelDto): AccountParcelDto {
  const waybill = accountOrderTextWaybill(parcel);
  if (!waybill) return parcel;
  const cached = cachedCarrierRecognition(waybill);
  if (cached) return textWaybillWithCarrier(parcel, waybill, cached);
  return carrierRecognitionExhausted(waybill)
    ? textWaybillWithCarrier(parcel, waybill, { normalization: null, exhausted: true })
    : parcel;
}

/**
 * T23: runs the recognizer for the carrier waybill an unprojected order's feed text names and applies it only
 * when a carrier matched. Best effort like the rest of carrier recognition; the order is unchanged otherwise.
 */
export async function withRecognizedAccountOrderTextWaybill(
  parcel: AccountParcelDto,
  options: AccountCarrierNormalizationOptions = {},
): Promise<AccountParcelDto> {
  const waybill = accountOrderTextWaybill(parcel);
  if (!waybill) return parcel;
  if (options.signal?.aborted) throw new OperationTimeoutError();
  try {
    const recognition = await (options.recognize || recognizeNonSyncCarrier)(
      waybill,
      { deadlineAtMs: options.deadlineAtMs, signal: options.signal, budget: options.budget,
        // 优化 5 (user 2026-10-03): the order row's first anchor goes with the paid stage.
        parcelAnchorAtMs: accountParcelClassifyAnchor(parcel) },
    );
    if (options.signal?.aborted) throw new OperationTimeoutError();
    return textWaybillWithCarrier(parcel, waybill, recognition);
  } catch (error) {
    if (recognitionInterrupted(error, options.signal)) throw error;
    if (error instanceof GatewayError || error instanceof OperationTimeoutError) {
      return withAccountOrderTextWaybill(parcel);
    }
    throw error;
  }
}

/**
 * Carrier identity for an account parcel: the built-in table, then the free Kuaidi100 recognition and
 * the existing paid fallback. Every account parcel with a real waybill takes this path (audit C2,
 * adopted 2026-09-25), so R-20 — a JD platform label on a non-JD waybill is no carrier evidence —
 * applies to every JD business source, not only to orders (user decision 2026-09-26, Pipi 十二条 2).
 * An order's feed-text waybill is recognised first and shown only with its carrier (T23, 2026-09-26).
 */
export async function prepareAccountParcelCarrier(
  parcel: AccountParcelDto,
  options: AccountCarrierNormalizationOptions = {},
): Promise<AccountParcelDto> {
  return normalizeAccountParcelCarrierBestEffort(
    await withRecognizedAccountOrderTextWaybill(parcel, options),
    options,
  );
}

export async function sendAccountCode(
  source: BindingSource,
  phone: string,
  deadlineAtMs?: number,
): Promise<void> {
  requireScriptSource(source);
  await accountApi(deadlineAtMs).sendCode({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phone,
  });
}

export async function verifyAccountBinding(
  source: BindingSource,
  phone: string,
  code: string,
  deadlineAtMs?: number,
): Promise<void> {
  requireScriptSource(source);
  await accountApi(deadlineAtMs).bind({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phone,
    code,
  });
}

/**
 * 接口 5 京东来源那一行在上游的身份（用户定 2026-09-05，实网口径）。
 *
 * 这三个值加上**订单号**才是 `/cpa/express/v2/query` 认得的那一票；上游那一行的 `mailNo` 本来
 * 就是京东内部的 16 位 `wlOrderId`（原始合同 §8.6），不是承运商运单号。联合页回填出来的真实
 * 承运商（极兔、顺丰……）只属于展示层，拿它去问小米，小米不认这一行。
 */
const JING_DONG_ACCOUNT_PROVIDER = "JingDong";

function detailRecord(
  parcel: AccountParcelDto,
  matchedPhone: string,
): AccountDetailRecord {
  const jingDongOrder = parcel.accountOrder === true;
  return {
    waybill: jingDongOrder ? parcel.orderId || parcel.ownerId : parcel.ownerId,
    companyCode: jingDongOrder
      ? JING_DONG_ACCOUNT_CP_CODE
      : parcel.rawCourierCode || "",
    name: jingDongOrder ? JING_DONG_ACCOUNT_NAME : parcel.rawCompanyName || "",
    provider: jingDongOrder ? JING_DONG_ACCOUNT_PROVIDER : parcel.sourceProvider,
    stateNumber: Number(parcel.sourceStateCode) || 0,
    updateTime: parcel.latestTimeText,
    phone: matchedPhone,
    channel: "1",
  };
}

export async function fetchAccountParcels(
  source: BindingSource,
  bindings: readonly AccountBinding[],
  requestDeadlineAtMs?: number,
  signal?: AbortSignal,
  /**
   * The sync round's recognition wait, shared with the round's later passes (用户 2026-09-27 第二轮清单：识别总时长三端
   * 对齐 30 秒). The list request itself spends none of it.
   */
  recognitionBudget: CarrierRecognitionBudget = new CarrierRecognitionBudget(),
): Promise<AccountParcelFetchResult> {
  requireScriptSource(source);
  assertWithinDeadline(requestDeadlineAtMs);
  const boundPhones = phones(bindings, source);
  if (!boundPhones.length) {
    return { parcels: [], rawRecords: 0, rejectedRecords: 0 };
  }
  const response = await accountApi(requestDeadlineAtMs, signal).sync({
    source: SCRIPT_BINDING_SOURCE,
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    phones: boundPhones,
  });
  const parsed = parseAccountSyncResult(SCRIPT_BINDING_SOURCE, response);
  const parcels: AccountParcelDto[] = [...parsed.parcels];
  // 用户 2026-09-27 第二轮清单：截断排后。A waybill cut off in an earlier round is recognised after the others;
  // the list keeps its own order.
  const recognitionOrder = truncatedCarrierRecognitionLast(
    parsed.parcels.map((_parcel, index) => index),
    (index) => [accountOrderTextWaybill(parsed.parcels[index]), parsed.parcels[index].waybill],
  );
  for (const index of recognitionOrder) {
    parcels[index] = await prepareAccountParcelCarrier(parsed.parcels[index], {
      deadlineAtMs: requestDeadlineAtMs,
      signal,
      budget: recognitionBudget,
    });
  }
  return {
    parcels,
    rawRecords: parsed.rawRecords,
    rejectedRecords: parsed.rejectedRecords,
  };
}

export async function queryAccountManual(
  source: BindingSource,
  bindings: readonly AccountBinding[],
  waybill: string,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): Promise<AccountParcelDto | null> {
  requireScriptSource(source);
  assertWithinDeadline(deadlineAtMs);
  const api = accountApi(deadlineAtMs, signal);
  const response = await api.timeline({
    source: SCRIPT_BINDING_SOURCE,
    mode: "manual",
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    waybill,
    phones: phones(bindings, source),
  });
  const parcel = parseAccountTimelineResponse(
    SCRIPT_BINDING_SOURCE,
    response,
    { waybill },
  );
  return parcel
    ? normalizeAccountParcelCarrierBestEffort(parcel, { deadlineAtMs, signal })
    : null;
}

export async function refreshAccountParcel(
  shipment: Shipment,
  deadlineAtMs?: number,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
  options: Readonly<{ recognizeCarrier?: boolean; beforeQuery?: () => void }> = {},
): Promise<AccountParcelDto | null> {
  const source = shipment.identity.bindingSource;
  if (!source || shipment.identity.manuallyAdded) return null;
  requireScriptSource(source);
  if (!shipment.accountRecord) return null;
  assertWithinDeadline(deadlineAtMs);
  const api = accountApi(deadlineAtMs, signal, onQueryAttempted, options.beforeQuery);
  const response = await api.timeline({
    source: SCRIPT_BINDING_SOURCE,
    mode: "detail",
    identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
    record: shipment.accountRecord,
  });
  const parcel = parseAccountTimelineResponse(SCRIPT_BINDING_SOURCE, response, {
    waybill: shipment.identity.sourceId,
    waybillAliases: normalizedProjectedWaybill(shipment.identity)
      ? [normalizedProjectedWaybill(shipment.identity)]
      : [],
    courierCode: shipment.identity.courierCode,
    rawCourierCode: shipment.identity.rawCourierCode,
    rawCompanyName: shipment.identity.rawCompanyName,
    companyName: shipment.identity.companyName,
    carrierNormalization: shipment.identity.carrierIsBuiltIn != null
      ? {
          standardCode: shipment.identity.carrierIsBuiltIn
            ? shipment.identity.courierCode
            : "",
          displayName: shipment.identity.carrierIsBuiltIn
            ? shipment.identity.companyName
            : "",
          kuaidi100Code: shipment.identity.carrierKuaidi100Code || "",
          isBuiltIn: shipment.identity.carrierIsBuiltIn === true,
          tableVersion: shipment.identity.carrierTableVersion,
        }
      : null,
    provider: shipment.identity.sourceProvider,
    phone: shipment.identity.phone,
  });
  // Detail responses may omit their identifier; the parser has already tied
  // that single response to the request's original account owner.
  const sameOrder = parcel && shipment.identity.accountOrder &&
    normalizeWaybill(parcel.ownerId) === normalizeWaybill(shipment.identity.sourceId) &&
    parcel.sourceProvider.toLowerCase() === String(shipment.identity.sourceProvider || "").toLowerCase();
  const orderParcel = sameOrder
    ? { ...parcel, accountOrder: true, orderId: shipment.identity.orderId || parcel.orderId,
        textIdentity: parcel.textIdentity || accountOrderTextIdentity(parcel.tracks) }
    : parcel;
  // Restore identity before the shared parcel conversion sanitizes order completion;
  // ORDER scope alone cannot reject surviving structured carrier confirmation.
  // Query history must never inherit the feed history carried by list restoration.
  const resolved = orderParcel?.accountOrder && !orderParcel.textIdentity
    ? { ...accountParcelWithExistingProjection(orderParcel, [shipment]),
        projectionTimeline: orderParcel.projectionTimeline }
    : orderParcel;
  return resolved
    ? options.recognizeCarrier === false
      ? directAccountCarrierPresentation(withAccountOrderTextWaybill(resolved))
      : prepareAccountParcelCarrier(resolved, { deadlineAtMs, signal })
    : resolved;
}

export function accountExternalAppName(shipment: Shipment): string {
  if (
    shipment.identity.manuallyAdded ||
    shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE ||
    !shipment.accountRecord ||
    normalizeWaybill(shipment.accountRecord.waybill) !== shipment.identity.sourceId
  ) return "";
  const provider = String(shipment.identity.sourceProvider || "").toLowerCase();
  if (provider !== String(shipment.accountRecord.provider || "").toLowerCase()) return "";
  if (provider === "shunfeng") {
    return loadAccountAppRoutes(shipment.accountRecord).some((target) => target.kind === "sf") ? "顺丰" : "";
  }
  return provider === "jingdong" ? "京东" : provider === "cainiao" ? "菜鸟" : "";
}

/** App links belong to getList entries; /query may return tracks without their jumpList. */
export async function fetchAccountExternalAppRoutes(
  shipment: Shipment,
  signal: AbortSignal,
): Promise<AccountAppTarget[]> {
  if (signal.aborted || !accountExternalAppName(shipment) || !shipment.accountRecord) return [];
  const startedAt = Date.now();
  const context = { source: SCRIPT_BINDING_SOURCE,
    sourceProvider: String(shipment.accountRecord.provider || "").toLowerCase(),
    waybillTail: displayWaybill(shipment).slice(-4), carrierCode: shipment.identity.courierCode };
  const cached = loadAccountAppRoutes(shipment.accountRecord);
  if (cached.length) {
    writeDiagnostic("detail.external.routes", { ...context, result: "cached", records: cached.length });
    return cached;
  }
  const record = shipment.accountRecord;
  if (!/^1[3-9]\d{9}$/.test(record.phone || "")) return [];
  writeDiagnostic("detail.external.request", { ...context, stage: "account_list", result: "started" });
  try {
    const response = await accountApi(Date.now() + 15_000, signal).sync({
      source: SCRIPT_BINDING_SOURCE,
      identity: loadAccountIdentity(SCRIPT_BINDING_SOURCE),
      phones: [record.phone!],
    });
    if (signal.aborted) return [];
    const parsed = parseAccountSyncResult(SCRIPT_BINDING_SOURCE, response);
    const parcel = parsed.parcels.find((item) => item.ownerId === record.waybill &&
      item.sourceProvider.toLowerCase() === context.sourceProvider &&
      item.rawCourierCode === record.companyCode && fullPhone(item, [record.phone!]) === record.phone);
    const route = parcel?.appRoute;
    const targets = route ? [...route.targets] : [];
    writeDiagnostic("detail.external.routes", {
      ...context, stage: "account_list", result: targets.length ? "ready" : parcel ? "links_missing" : "record_missing",
      records: targets.length, rawRecords: parsed.rawRecords, durationMs: Date.now() - startedAt,
    });
    if (route) {
      try {
        saveAccountAppRoutes([{ record, route }]);
      } catch (error) {
        writeDiagnostic("detail.external.cache_failed", { ...context, ...diagnosticErrorDetails(error) }, "warning");
      }
    }
    return targets;
  } catch (error) {
    if (!signal.aborted) writeDiagnostic("detail.external.request_failed", {
      ...context, ...diagnosticErrorDetails(error), durationMs: Date.now() - startedAt,
    }, "warning");
    throw error;
  }
}

function trustedRouteKind(
  parcel: AccountParcelDto,
): ShipmentRoute["kind"] | null {
  if (
    String(parcel.sourceProvider || "").trim().toLowerCase() !== "cainiao" ||
    !parcel.routeUrl
  ) return null;
  try {
    const host = new URL(parcel.routeUrl).hostname.toLowerCase();
    if (
      host === "cainiao.com" ||
      host.endsWith(".cainiao.com") ||
      host === "taobao.com" ||
      host.endsWith(".taobao.com")
    ) {
      return "cainiao";
    }
  } catch {
    return null;
  }
  return null;
}

function fullPhone(
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
): string {
  const matched = matchBoundPhone(parcel, boundPhones);
  if (matched) return matched;
  const hasEvidence = [parcel.receiverPhone, parcel.senderPhone]
    .map(normalizePhoneEvidence)
    .some((value) => value.length >= 4);
  return !hasEvidence && boundPhones.length === 1 ? boundPhones[0] : "";
}

/**
 * Reattaches a confirmed order projection from its durable automatic-source
 * observation. The projected order can be presented by another canonical
 * waybill owner, so the top-level shipment id is not sufficient authority.
 */
export function accountParcelWithExistingProjection(
  parcel: AccountParcelDto,
  shipments: readonly Shipment[],
): AccountParcelDto {
  if (!parcel.accountOrder) return parcel;
  const ownerId = normalizeWaybill(parcel.ownerId);
  const expectedId = `${parcel.source}:account:${ownerId}`;
  const authorities = shipments.flatMap((shipment) => [
    ...(shipment.identity.id === expectedId
      ? [{
          identity: shipment.identity,
          sourceTimeline: shipment.sourceTimeline || shipment.timeline,
        }]
      : []),
    ...(shipment.automaticOwnership?.observations || [])
      .filter((observation) =>
        observation.bindingValid !== false &&
        observation.source === parcel.source &&
        observation.identity.id === expectedId
      )
      .map((observation) => ({
        identity: observation.identity,
        sourceTimeline: observation.sourceTimeline,
      })),
  ]);
  const projectedAuthority = authorities.find(({ identity }) =>
    identity.accountOrder &&
    identity.bindingSource === parcel.source &&
    normalizeWaybill(identity.sourceId) === ownerId &&
    Boolean(normalizedProjectedWaybill(identity))
  );
  const projectedIdentity = projectedAuthority?.identity;
  const projectedWaybill = normalizedProjectedWaybill(projectedIdentity);
  // Feed text names only the waybill (其余裁决 7, 2026-09-26): it no longer supplies or repairs a carrier.
  // A projection that already names its carrier without a code (a Kuaidi100 off-table name, or the raw code shown after
  // an exhausted recognition; 其余裁决 29、32) keeps it: the order's own platform code (JDKD) is no carrier code for it.
  return projectedWaybill
    ? {
        ...parcel,
        waybill: projectedWaybill,
        courierCode: projectedIdentity?.courierCode ||
          (String(projectedIdentity?.companyName || "").trim() ? "" : parcel.courierCode),
        companyName: projectedIdentity?.companyName || parcel.companyName,
        projectionTimeline:
          parcel.projectionTimeline || projectedAuthority?.sourceTimeline || null,
      }
    : parcel;
}

/**
 * Status and the list surface belong to the FEED source; the JD H5 package supplies tracks only
 * (user rule, restated 2026-09-04). A complete projection used to replace the account package
 * whole, taking its status with it — and the projection's own semantic is derived from the newest
 * node's text (`semanticFromText`), which AGENTS §9 forbids as status evidence in the first place.
 * Two signed-for rows fell to 暂无状态 that way, their delivery text unchanged.
 */
/**
 * 用户定 2026-09-04（§9 总纲）：feed 提供的每个字段都归 feed——状态、结构化状态时间、**列表头条**。
 * H5 只供轨迹。原先这里只把 semantic/statusEventAtMs 拿回来，头条与事件时间仍是 H5 的，于是出现
 * 「状态跟着 feed 推进、头条却停在抓取那一刻」——极兔那票停在 06:17 且越抓越旧（2026-09-04 观察）。
 */
function withAccountPresentation(
  projected: TimelinePackage,
  account: TimelinePackage | null,
  takesHeadline = true,
): TimelinePackage {
  if (!account) return projected;
  return {
    ...projected,
    semantic: account.semantic,
    statusEventAtMs: account.statusEventAtMs,
    structuredStatus: account.structuredStatus === true,
    ...statusProjectionFields(account, projected),
    latestTimeText: takesHeadline
      ? account.latestTimeText || projected.latestTimeText
      : projected.latestTimeText,
    latestDetail: takesHeadline
      ? account.latestDetail || projected.latestDetail
      : projected.latestDetail,
  };
}

/**
 * 列表这一行的结构化状态，取在 parcelToShipment 把未投影订单的「已揽收」压成「已下单」之前（压完以后行上
 * 只剩 ORDERED，也不再挂 normalizedStatus）。首页投影门问的是承运商揽收了没有，要看压之前的这一个
 * （2026-09-24）。结构化的判据与 parcelToShipment 的 structuredStatus 相同；不是结构化的返回 null。
 */
export function accountParcelStructuredSemantic(parcel: AccountParcelDto): StatusSemantic | null {
  if (parcel.normalizedStatus) {
    return parcel.normalizedStatus.structured ? parcel.normalizedStatus.semantic : null;
  }
  const semantic = parcel.semantic;
  const coded = parcel.source === "interface5"
    ? semanticFromAccountState(parcel.sourceStateCode, "")
    : semanticFromStored(parcel.sourceStateCode, "");
  return semantic !== "UNKNOWN" && semantic === coded ? semantic : null;
}

const STORED_LIST_SEMANTICS = new Set<StatusSemantic>([
  "CANCELLED", "DANGER", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED",
]);

/** Records the list row's pre-clamp structured status on the row it produced (audit L8). */
export function withListStructuredSemantic(shipment: Shipment, parcel: AccountParcelDto): Shipment {
  const semantic = parcel.source === "interface5" ? accountParcelStructuredSemantic(parcel) : null;
  if ((shipment.listStructuredSemantic ?? null) === semantic) return shipment;
  const next = { ...shipment };
  if (semantic) next.listStructuredSemantic = semantic;
  else delete next.listStructuredSemantic;
  return next;
}

/**
 * 存盘行的列表结构化状态（2026-09-24，首页存盘行投影用）。存盘时未投影订单行的「已揽收」已被压成「已下单」、
 * normalizedStatus 也不再挂，从行上重建的 parcel 交给 accountParcelStructuredSemantic 只会得到 null；列表那一行
 * 原始的接口 5 状态码还在 accountRecord.stateNumber 里（101…111，与 Worker 小米映射同一张表：103 揽收、
 * 104 运输、105 派送、106 待取件）。不是接口 5、没有记录或状态码不认识时返回 null。
 */
export function storedAccountListStructuredSemantic(shipment: Shipment): StatusSemantic | null {
  const record = shipment.accountRecord;
  if (!record || shipment.identity.bindingSource !== "interface5") return null;
  // The Worker's own pre-clamp status, stored by the list sync (audit L8): it carries the Worker's rules
  // that the raw state code alone does not.
  const stored = shipment.listStructuredSemantic;
  if (stored && STORED_LIST_SEMANTICS.has(stored)) return stored;
  const code = Number(record.stateNumber);
  if (!Number.isInteger(code) || code <= 0) return null;
  const semantic = semanticFromAccountState(code, "");
  return semantic === "UNKNOWN" ? null : semantic;
}

export function parcelToShipment(
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  now = Date.now(),
): Shipment | null {
  // Identity extraction is independent of shipment status and history completeness.
  parcel = withAccountOrderTextWaybill(parcel);
  const ownerId = normalizeWaybill(parcel.ownerId);
  const displayWaybill = normalizeWaybill(parcel.waybill);
  if (!ownerId || !displayWaybill) return null;
  const associatedPhone = fullPhone(parcel, boundPhones);
  if (!associatedPhone) return null;
  const tracks: TrackNode[] = parcel.tracks
    .map((track) => ({
      timeText: track.timeText,
      timeMs: parseProviderTime(track.timeText),
      detail: track.detail,
      statusCode: track.statusCode,
      raw: { ...(track.statusCode ? { statusCode: track.statusCode } : {}),
        ...(track.normalizedStatus ? { normalizedStatus: track.normalizedStatus } : {}),
        _pipiStatusSource: parcel.source },
    }))
    .filter((track) => Boolean(track.detail));
  const latest = tracks.find((track) => track.timeMs != null) || tracks[0];
  const unprojectedOrder = parcel.accountOrder && displayWaybill === ownerId;
  let semantic = parcel.semantic as StatusSemantic;
  if (!parcel.normalizedStatus && semantic === "UNKNOWN" && latest) {
    semantic = semanticFromText(latest.detail);
  }
  if (
    unprojectedOrder &&
    (
      semantic === "PICKED" ||
      (!parcel.normalizedStatus && semanticFromText(parcel.latestDetail) === "PICKED")
    )
  ) {
    semantic = "ORDERED";
  }
  const routeKind = trustedRouteKind(parcel);
  const projectedPresentation = parcel.accountOrder && !unprojectedOrder
    ? projectedCarrierPresentation(
        displayWaybill,
        parcel.courierCode,
        parcel.companyName,
      )
    : null;
  const courierCode = projectedPresentation?.courierCode ?? parcel.courierCode;
  const companyName = unprojectedOrder
    ? "京东购物"
    : projectedPresentation?.companyName ?? (parcel.companyName || courierCode);
  const accountTimeline = {
    provider: parcel.source,
    waybill: displayWaybill,
    courierCode,
    companyName,
    semantic,
    // Order identity still owns presentation until a carrier waybill is resolved.
    ...(parcel.normalizedStatus?.semantic === semantic ? { normalizedStatus: parcel.normalizedStatus } : {}),
    structuredStatus: parcel.normalizedStatus?.structured ?? (semantic !== "UNKNOWN" && semantic === (
      parcel.source === "interface5"
        ? semanticFromAccountState(parcel.sourceStateCode, "")
        : semanticFromStored(parcel.sourceStateCode, "")
    )),
    statusEventAtMs: parcel.normalizedStatus ? parcel.normalizedStatus.eventAtMs || null
      : latest?.timeMs || parseProviderTime(parcel.latestTimeText),
    latestTimeText: latest?.timeText || parcel.latestTimeText,
    latestDetail: latest?.detail || parcel.latestDetail,
    tracks,
    successAtMs: now,
  } satisfies Shipment["timeline"];
  const projectionTimeline = parcel.projectionTimeline &&
      normalizeWaybill(parcel.projectionTimeline.waybill) === displayWaybill
    ? {
        ...parcel.projectionTimeline,
        provider: parcel.source,
        waybill: displayWaybill,
        courierCode,
        companyName,
      }
    : null;
  // Keep the list snapshot separate from projected H5 history. An H5-only clock cannot
  // make the current list response look stale when restoring a known waybill.
  const split = projectionTimeline ? splitJingDongH5Nodes(projectionTimeline) : null;
  const carriedFeed = split?.feed || null;
  const orderScopedCompletion = parcel.normalizedStatusScope === "ORDER" &&
    accountTimeline.semantic === "COMPLETED";
  const projectionIdentity = {
    accountOrder: parcel.accountOrder,
    manuallyAdded: false,
    bindingSource: parcel.source,
    sourceProvider: parcel.sourceProvider,
    sourceId: ownerId,
    orderId: parcel.orderId || (parcel.accountOrder ? ownerId : ""),
    projectedWaybill: unprojectedOrder ? "" : displayWaybill,
  };
  const sanitizedAccountTimeline = withoutJingDongOrderCompletion(
    accountTimeline, projectionIdentity, orderScopedCompletion,
  );
  // v5 list scope follows the order-number identity, including real 107 delivery
  // events. Keep inferred order completion and rejected shopping-review evidence
  // from advancing a projected parcel, without rejecting structured delivery confirmation.
  const orderCompletion = orderScopedCompletion && (
    !accountTimeline.structuredStatus || sanitizedAccountTimeline.semantic !== "COMPLETED"
  );
  const summaryParticipates = !carriedFeed || (!orderCompletion && (
    (parcel.source === "interface5" && carriedFeed.semantic === accountTimeline.semantic) ||
    !timedTracks(carriedFeed.tracks).length ||
    parcel.normalizedStatusScope === "SHIPMENT" ||
    incomingStatusAdvances(carriedFeed.semantic, accountTimeline.semantic)
  ));
  const timeline = !carriedFeed
    ? sanitizedAccountTimeline
    : summaryParticipates
      ? withAccountPresentation(
          mergeTimelinePackage(
            split?.jdH5 && !carriedFeed.tracks.length && carriedFeed.structuredStatus !== true
              ? null : withoutJingDongOrderCompletion(carriedFeed, projectionIdentity),
            sanitizedAccountTimeline,
            parcel.source !== "interface5",
          ),
          sanitizedAccountTimeline,
        )
      : withoutJingDongOrderCompletion(carriedFeed, projectionIdentity);
  const projectedJingDongH5 = split?.jdH5 && split.jdH5.complete === true &&
      timedTracks(split.jdH5.tracks).length
    ? split.jdH5
    : null;
  const normalizedStatusScope = parcel.normalizedStatusScope;
  const statusPresentation =
      parcel.normalizedStatusSemantic && parcel.normalizedStatusText &&
      normalizedStatusScope === "ORDER" && unprojectedOrder
    ? {
        scope: normalizedStatusScope,
        semantic: parcel.normalizedStatusSemantic,
        text: parcel.normalizedStatusText,
      } as const
    : undefined;
  return {
    identity: {
      id: `${parcel.source}:account:${ownerId}`,
      bindingSource: parcel.source,
      sourceOwner: parcel.accountOrder ? `${parcel.source}:order` : parcel.source,
      sourceId: ownerId,
      phoneTail: associatedPhone.slice(-4),
      phone: associatedPhone,
      courierCode,
      rawCourierCode: parcel.rawCourierCode,
      rawCompanyName: parcel.rawCompanyName,
      companyName,
      carrierIsBuiltIn: parcel.carrierNormalization?.isBuiltIn,
      carrierKuaidi100Code: parcel.carrierNormalization?.kuaidi100Code,
      carrierTableVersion: parcel.carrierNormalization?.tableVersion,
      sourceProvider: parcel.sourceProvider,
      // Xiaomi ExpressUtils.isSelfSend uses exact bound-phone membership.
      sender: parcel.source === "interface5"
        ? Boolean(parcel.senderPhone && boundPhones.includes(parcel.senderPhone))
        : undefined,
      orderId: parcel.accountOrder ? parcel.orderId || ownerId : "",
      projectedWaybill: parcel.accountOrder && !unprojectedOrder
        ? displayWaybill
        : "",
      accountOrder: parcel.accountOrder,
      manuallyAdded: false,
      createdAtMs: now,
    },
    timeline,
    sourceTimeline: timeline,
    manualTimelines: projectedJingDongH5 ? [projectedJingDongH5] : [],
    statusPresentation,
    route: routeKind ? { kind: routeKind, source: parcel.source } : null,
    accountRecord: detailRecord(parcel, associatedPhone),
    updatedAtMs: now,
  };
}
