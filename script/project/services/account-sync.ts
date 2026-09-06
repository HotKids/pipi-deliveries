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
  semanticFromText,
  splitJingDongH5Nodes,
  timedTracks,
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
import {
  normalizeAccountParcelCarrier,
  type AccountCarrierNormalizationOptions,
} from "./account-carrier-normalization";

export type AccountParcelFetchResult = Readonly<{
  parcels: readonly AccountParcelDto[];
  rawRecords: number;
  rejectedRecords: number;
}>;

function accountApi(deadlineAtMs?: number, signal?: AbortSignal): AccountApi {
  return new AccountApi((route, payload, timeoutMs) =>
    postGateway(route, payload, {
      timeoutMs: remainingTimeoutMs(deadlineAtMs, timeoutMs),
      deadlineAtMs,
      signal,
    }),
  );
}

function phones(bindings: readonly AccountBinding[], source: BindingSource): string[] {
  return bindings
    .filter((binding) => binding.source === source)
    .map((binding) => binding.phone);
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
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) throw error;
    if (
      error instanceof GatewayError ||
      error instanceof OperationTimeoutError
    ) return parcel;
    throw error;
  }
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
const JING_DONG_ACCOUNT_CP_CODE = "JDKD";
const JING_DONG_ACCOUNT_NAME = "京东商品快递";

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
  const parcels: AccountParcelDto[] = [];
  for (const parcel of parsed.parcels) {
    parcels.push(parcel.accountOrder
      ? await normalizeAccountParcelCarrierBestEffort(parcel, {
          deadlineAtMs: requestDeadlineAtMs,
          signal,
        })
      : parcel);
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
): Promise<AccountParcelDto | null> {
  const source = shipment.identity.bindingSource;
  if (!source || shipment.identity.manuallyAdded) return null;
  requireScriptSource(source);
  if (!shipment.accountRecord) return null;
  assertWithinDeadline(deadlineAtMs);
  const api = accountApi(deadlineAtMs, signal);
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
  return parcel && shipment.identity.accountOrder
    ? normalizeAccountParcelCarrierBestEffort(parcel, { deadlineAtMs, signal })
    : parcel;
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
    // Feed text naming the same carrier waybill is fresh carrier evidence for an already
  // projected owner and repairs an identity that was labelled from the order stage.
  const textIdentity = parcel.textIdentity;
  const textCarrier = textIdentity && projectedWaybill &&
      normalizeWaybill(textIdentity.waybill) === projectedWaybill &&
      textIdentity.courierCode
    ? textIdentity
    : null;
  return projectedWaybill
    ? {
        ...parcel,
        waybill: projectedWaybill,
        courierCode: textCarrier?.courierCode ||
          projectedIdentity?.courierCode || parcel.courierCode,
        companyName: textCarrier?.companyName ||
          projectedIdentity?.companyName || parcel.companyName,
        ...(textCarrier ? { rawCourierCode: "", carrierNormalization: null } : {}),
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
    latestTimeText: takesHeadline
      ? account.latestTimeText || projected.latestTimeText
      : projected.latestTimeText,
    latestDetail: takesHeadline
      ? account.latestDetail || projected.latestDetail
      : projected.latestDetail,
  };
}

export function parcelToShipment(
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  now = Date.now(),
): Shipment | null {
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
      raw: track.statusCode
        ? { statusCode: track.statusCode, _pipiStatusSource: parcel.source }
        : { _pipiStatusSource: parcel.source },
    }))
    .filter((track) => Boolean(track.detail));
  const latest = tracks.find((track) => track.timeMs != null) || tracks[0];
  const unprojectedOrder = parcel.accountOrder && displayWaybill === ownerId;
  let semantic = parcel.semantic as StatusSemantic;
  if (semantic === "UNKNOWN" && latest) {
    semantic = semanticFromText(latest.detail);
  }
  if (
    unprojectedOrder &&
    (
      semantic === "PICKED" ||
      semanticFromText(parcel.latestDetail) === "PICKED"
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
  const courierCode = projectedPresentation?.courierCode || parcel.courierCode;
  const companyName = unprojectedOrder
    ? "京东购物"
    : projectedPresentation?.companyName || parcel.companyName || courierCode || "快递";
  const accountTimeline = {
    provider: parcel.source,
    waybill: displayWaybill,
    courierCode,
    companyName,
    semantic,
    statusEventAtMs: latest?.timeMs || parseProviderTime(parcel.latestTimeText),
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
  // 用户定 2026-09-05 晚：feed 增量与 query 是两个独立的包，不拼接。行（状态、头条、事件时间、
  // 自己的节点）永远归 feed：带过来的 source 包只保留 feed 自己的节点，跟这次的 feed 节点做同源
  // 增量合并。联合页抓到的完整 H5 包只住 jd_h5 槽，由详情页选包；不完整的 H5 包照旧不存。
  // 之前这里把 H5 节点并进 feed 轨迹（2026-09-04 的「轨迹也归 feed」），详情页就出现同一分钟
  // 的两条「已揽收完成」——一条 feed 的、一条 H5 的（2026-09-05 晚，京东 0822）。
  const split = projectionTimeline ? splitJingDongH5Nodes(projectionTimeline) : null;
  const carriedFeed = split && timedTracks(split.feed.tracks).length ? split.feed : null;
  // 带过来的 feed 包与这次 feed 摘要同源增量合并。ORDER 级摘要且状态没推进时（一条「订单已完成」
  // 打在已签收多日的归档行上）整条不参与——既不接管状态/事件时间/头条，也不写节点，否则归档行
  // 会被拉回列表（2026-09-04 的老规则，跟「不拼接」无关：这是 feed 自己的订单级摘要）；SHIPMENT
  // 级、或状态确有推进，这次的 feed 才并进增量并接管展示。
  const summaryParticipates = !carriedFeed ||
    parcel.normalizedStatusScope === "SHIPMENT" ||
    incomingStatusAdvances(carriedFeed.semantic, accountTimeline.semantic);
  const timeline = !carriedFeed
    ? accountTimeline
    : summaryParticipates
      ? withAccountPresentation(
          mergeTimelinePackage(carriedFeed, accountTimeline),
          accountTimeline,
        )
      : carriedFeed;
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

export function parcelToManualShipment(
  parcel: AccountParcelDto,
  phoneTail: string,
  now = Date.now(),
  bindingSource: BindingSource = SCRIPT_BINDING_SOURCE,
): Shipment | null {
  requireScriptSource(bindingSource);
  const waybill = normalizeWaybill(parcel.waybill || parcel.ownerId);
  if (!waybill) return null;
  const tracks: TrackNode[] = parcel.tracks
    .map((track) => ({
      timeText: track.timeText,
      timeMs: parseProviderTime(track.timeText),
      detail: track.detail,
      statusCode: track.statusCode,
      raw: track.statusCode
        ? { statusCode: track.statusCode, _pipiStatusSource: parcel.source }
        : { _pipiStatusSource: parcel.source },
    }))
    .filter((track) => Boolean(track.detail));
  const latest = tracks.find((track) => track.timeMs != null) || tracks[0];
  let semantic = parcel.semantic as StatusSemantic;
  if (semantic === "UNKNOWN" && latest) semantic = semanticFromText(latest.detail);
  const companyName = parcel.companyName || parcel.courierCode || "快递";
  const routeKind = trustedRouteKind(parcel);
  const timeline = {
    provider: parcel.source,
    waybill,
    courierCode: parcel.courierCode,
    companyName,
    semantic,
    statusEventAtMs: latest?.timeMs || parseProviderTime(parcel.latestTimeText),
    latestTimeText: latest?.timeText || parcel.latestTimeText,
    latestDetail: latest?.detail || parcel.latestDetail,
    tracks,
    successAtMs: now,
  } satisfies Shipment["timeline"];
  return {
    identity: {
      id: `${bindingSource}:manual:${waybill}`,
      bindingSource,
      sourceOwner: "manual",
      sourceId: waybill,
      phoneTail: String(phoneTail || "").slice(-4),
      courierCode: parcel.courierCode,
      rawCourierCode: parcel.rawCourierCode,
      rawCompanyName: parcel.rawCompanyName,
      companyName,
      carrierIsBuiltIn: parcel.carrierNormalization?.isBuiltIn,
      carrierKuaidi100Code: parcel.carrierNormalization?.kuaidi100Code,
      carrierTableVersion: parcel.carrierNormalization?.tableVersion,
      sourceProvider: parcel.sourceProvider,
      accountOrder: false,
      manuallyAdded: true,
      createdAtMs: now,
    },
    timeline,
    sourceTimeline: null,
    manualTimelines: [timeline],
    route: routeKind ? { kind: routeKind, source: bindingSource } : null,
    accountRecord: null,
    updatedAtMs: now,
  };
}
