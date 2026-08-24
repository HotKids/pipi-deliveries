import type {
  AccountBinding,
  BindingSource,
  PendingManualQuery,
  Shipment,
} from "../models";
import { requireScriptSource } from "./script-source";
import {
  parcelToManualShipment,
  queryAccountManual,
} from "./account-sync";
import { postGateway } from "./gateway";
import {
  normalizeWaybill,
  isProviderErrorDetail,
  timedTracks,
  usableTimedTracks,
} from "./status";
import {
  assertWithinDeadline,
  remainingTimeoutMs,
} from "./deadline";
import {
  kuaidi100PhoneRejected,
  parseKuaidi100Timeline,
  rejectKuaidi100Response,
  type JsonObject,
  type ParsedManualTimeline,
} from "./manual-query-parser";
import {
  guessCarrierQueryByWaybill,
  resolveCarrierQuery,
  queryPhoneTails,
} from "./carrier-query";
import { projectedCarrierPresentation } from "./carrier-presentation";

class Kuaidi100QueryError extends Error {
  constructor(
    message: string,
    readonly needsPhoneTail = false,
  ) {
    super(message);
    this.name = "Kuaidi100QueryError";
  }
}

function phoneTailFailure(error: unknown): error is Kuaidi100QueryError {
  return error instanceof Kuaidi100QueryError && error.needsPhoneTail;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

function classifyCandidates(root: JsonObject): Array<{
  courierCode: string;
  companyName: string;
}> {
  const source = Array.isArray(root.auto) ? root.auto : [];
  const result: Array<{ courierCode: string; companyName: string }> = [];
  for (const value of source) {
    const item = object(value);
    const courierCode = firstText(item, "comCode", "code");
    if (!courierCode || result.some((entry) => entry.courierCode === courierCode)) {
      continue;
    }
    result.push({
      courierCode,
      companyName: firstText(item, "name", "comName", "companyName"),
    });
  }
  return result;
}

export type ManualCarrierDetection = {
  courierCode: string;
  companyName: string;
  requiresPhoneTail: boolean;
};

export async function detectManualCarrier(
  waybillInput: string,
): Promise<ManualCarrierDetection | null> {
  const waybill = normalizeWaybill(waybillInput);
  if (waybill.length < 6) return null;

  let candidate: { courierCode: string; companyName: string } | null = null;
  try {
    candidate = classifyCandidates(
      await postGateway<JsonObject>(
        "/api/express/classify",
        { waybill },
        { timeoutMs: 15_000 },
      ),
    )[0] || null;
  } catch {
    // An unambiguous waybill prefix can still provide a local presentation.
  }

  const carrier = candidate
    ? resolveCarrierQuery(candidate.courierCode)
    : guessCarrierQueryByWaybill(waybill);
  if (!candidate && !carrier) return null;

  const courierCode = carrier?.standardCode || candidate?.courierCode || "";
  const presentation = projectedCarrierPresentation(
    waybill,
    courierCode,
    candidate?.companyName || "",
  );
  if (!presentation.companyName || presentation.companyName === "快递") {
    return null;
  }
  return {
    courierCode: presentation.courierCode || courierCode,
    companyName: presentation.companyName,
    requiresPhoneTail: carrier?.requiresPhoneTail || false,
  };
}

function shipmentFromTimeline(input: {
  waybill: string;
  phoneTail: string;
  courierCode: string;
  companyName: string;
  bindingSource: BindingSource | null;
  provider: string;
  parsed: ParsedManualTimeline;
}): Shipment {
  const now = Date.now();
  const timeline = {
    provider: input.provider,
    waybill: input.waybill,
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

function hasRealTracking(shipment: Shipment | null): boolean {
  return Boolean(
    shipment &&
    (usableTimedTracks(shipment.timeline.tracks).length ||
      shipment.timeline.tracks.some(
        (track) =>
          Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
      )),
  );
}

async function queryCandidate(
  waybill: string,
  phoneTail: string,
  courierCode: string,
  companyNameHint: string,
  bindingSource: BindingSource | null,
  deadlineAtMs?: number,
): Promise<Shipment> {
  assertWithinDeadline(deadlineAtMs);
  const root = await postGateway<JsonObject>("/api/express/timeline/preferred", {
    waybill,
    companyCode: courierCode,
    phone: phoneTail,
  }, {
    timeoutMs: remainingTimeoutMs(deadlineAtMs, 30_000),
    deadlineAtMs,
  });
  const phoneRejected = kuaidi100PhoneRejected(root);
  if (rejectKuaidi100Response(root)) {
    if (phoneRejected) {
      throw new Kuaidi100QueryError(
        phoneTail ? "手机尾号不正确，请重新输入" : "请输入手机尾号",
        true,
      );
    }
    throw new Kuaidi100QueryError("查询失败，请稍后重试");
  }
  const parsed = parseKuaidi100Timeline(root);
  const companyName = firstText(root, "companyName", "comName") || companyNameHint || courierCode;
  return shipmentFromTimeline({
    waybill,
    phoneTail,
    courierCode,
    companyName,
    bindingSource,
    provider: "kuaidi100",
    parsed,
  });
}

async function queryCarrierCandidate(
  waybill: string,
  courierCode: string,
  companyNameHint: string,
  bindingSource: BindingSource | null,
  explicitTail: string,
  boundTails: readonly string[],
  deadlineAtMs?: number,
): Promise<Shipment> {
  const carrier = resolveCarrierQuery(courierCode);
  const tails = queryPhoneTails(carrier, explicitTail, boundTails);
  if (carrier?.requiresPhoneTail && !tails.length) {
    throw new Kuaidi100QueryError("请输入手机尾号", true);
  }

  let lastError: unknown = null;
  const firstTail = carrier?.requiresPhoneTail ? null : tails[0] || "";
  if (firstTail != null) {
    try {
      return await queryCandidate(
        waybill,
        firstTail,
        carrier?.kuaidi100Code || courierCode,
        companyNameHint,
        bindingSource,
        deadlineAtMs,
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
      : new Kuaidi100QueryError("请输入手机尾号", true);
  }
  for (const phoneTail of suppliedTails) {
    assertWithinDeadline(deadlineAtMs);
    try {
      return await queryCandidate(
        waybill,
        phoneTail,
        carrier?.kuaidi100Code || courierCode,
        companyNameHint,
        bindingSource,
        deadlineAtMs,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Kuaidi100QueryError("请输入手机尾号", true);
}

export async function queryManualShipment(input: {
  waybill: string;
  phoneTail?: string;
  deadlineAtMs?: number;
}): Promise<Shipment> {
  return queryKuaidi100Shipment(input);
}

export async function queryKuaidi100Shipment(input: {
  waybill: string;
  phoneTail?: string;
  courierCode?: string;
  companyName?: string;
  bindingSource?: BindingSource | null;
  phoneTails?: readonly string[];
  deadlineAtMs?: number;
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
  const hintedCode = String(input.courierCode || "").trim();
  const hintedCarrier = resolveCarrierQuery(hintedCode);
  const candidates: Array<{ courierCode: string; companyName: string }> = [];
  try {
    candidates.push(...classifyCandidates(
      await postGateway<JsonObject>(
        "/api/express/classify",
        { waybill },
        {
          timeoutMs: remainingTimeoutMs(input.deadlineAtMs, 15_000),
          deadlineAtMs: input.deadlineAtMs,
        },
      ),
    ));
  } catch {
    // A trusted local hint or unambiguous waybill prefix can still recover the lookup.
  }
  const fallbackCarrier = hintedCarrier || (
    candidates.length ? null : guessCarrierQueryByWaybill(waybill)
  );
  if (
    fallbackCarrier &&
    !candidates.some(
      (candidate) =>
        resolveCarrierQuery(candidate.courierCode)?.kuaidi100Code ===
        fallbackCarrier.kuaidi100Code,
    )
  ) {
    candidates.push({
      courierCode: fallbackCarrier.kuaidi100Code,
      companyName: String(input.companyName || "").trim(),
    });
  }
  if (!candidates.length) throw new Error("无法识别");

  let lastError: unknown = null;
  let phoneError: Error | null = null;
  let noTrackFallback: Shipment | null = null;
  for (const candidate of candidates) {
    const carrier = resolveCarrierQuery(candidate.courierCode);
    try {
      const shipment = await queryCarrierCandidate(
        waybill,
        carrier?.kuaidi100Code || candidate.courierCode,
        candidate.companyName,
        input.bindingSource || null,
        explicitTail,
        boundTails,
        input.deadlineAtMs,
      );
      if (hasRealTracking(shipment)) return shipment;
      noTrackFallback ||= shipment;
      if (candidates.length === 1) return shipment;
    } catch (error) {
      lastError = error;
      if (phoneTailFailure(error)) phoneError = error;
    }
  }
  if (phoneError) throw phoneError;
  if (noTrackFallback) return noTrackFallback;
  if (lastError instanceof Error) throw lastError;
  throw new Error("暂无轨迹");
}

export type ManualQueryOutcome = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
};

export async function queryManualForSource(input: {
  source: BindingSource;
  bindings: readonly AccountBinding[];
  waybill: string;
  phoneTail?: string;
  courierCode?: string;
  companyName?: string;
  preferKuaidi100?: boolean;
  deadlineAtMs?: number;
}): Promise<ManualQueryOutcome> {
  requireScriptSource(input.source);
  const waybill = normalizeWaybill(input.waybill);
  if (waybill.length < 6) throw new Error("请输入有效的快递单号");
  const phoneTail = String(input.phoneTail || "").trim();
  if (phoneTail && !/^\d{4}$/.test(phoneTail)) {
    throw new Error("请输入 4 位手机尾号");
  }

  let accountShipment: Shipment | null = null;
  let accountRouteUrl = "";
  let k100Shipment: Shipment | null = null;
  let accountError: unknown = null;
  let k100Error: unknown = null;

  const queryAccount = async (): Promise<{
    shipment: Shipment | null;
    routeUrl: string;
  }> => {
    const parcel = await queryAccountManual(
      input.source,
      waybill,
      input.deadlineAtMs,
    );
    if (!parcel) return { shipment: null, routeUrl: "" };
    const shipment = parcelToManualShipment(
      parcel,
      phoneTail,
      Date.now(),
      input.source,
    );
    return {
      shipment,
      routeUrl: shipment?.route?.kind === "cainiao" ? parcel.routeUrl : "",
    };
  };

  const queryK100 = async (
    account: Shipment | null,
  ): Promise<Shipment> =>
    queryKuaidi100Shipment({
      waybill,
      phoneTail,
      phoneTails: input.bindings.map((binding) => binding.phone.slice(-4)),
      courierCode:
        account?.identity.courierCode || input.courierCode,
      companyName:
        account?.identity.companyName || input.companyName,
      bindingSource: input.source,
      deadlineAtMs: input.deadlineAtMs,
    });

  const hasTimed = (shipment: Shipment | null): boolean =>
    Boolean(shipment && timedTracks(shipment.timeline.tracks).length);
  const hasReal = hasRealTracking;

  let selected: Shipment | null = null;
  let selectedRouteUrl = "";

  if (input.preferKuaidi100) {
    try {
      const k100 = await queryK100(accountShipment);
      k100Shipment = k100;
      if (hasTimed(k100)) selected = k100;
    } catch (error) {
      k100Error = error;
    }
    if (!selected) {
      try {
        const result = await queryAccount();
        accountShipment = result.shipment;
        accountRouteUrl = result.routeUrl;
        const account = result.shipment;
        if ((account && hasTimed(account)) || !k100Shipment) {
          selected = account;
          selectedRouteUrl = account ? accountRouteUrl : "";
        } else {
          selected = k100Shipment;
        }
      } catch (error) {
        accountError = error;
        selected = k100Shipment;
      }
    }
  } else {
    try {
      const result = await queryAccount();
      accountShipment = result.shipment;
      accountRouteUrl = result.routeUrl;
      const account = result.shipment;
      if (account && hasReal(account)) {
        selected = account;
        selectedRouteUrl = accountRouteUrl;
      }
    } catch (error) {
      accountError = error;
    }
    if (!selected) {
      try {
        const k100 = await queryK100(accountShipment);
        k100Shipment = k100;
        selected = hasReal(k100) || !accountShipment ? k100 : accountShipment;
        selectedRouteUrl = selected === accountShipment ? accountRouteUrl : "";
      } catch (error) {
        k100Error = error;
        selected = accountShipment;
        selectedRouteUrl = selected ? accountRouteUrl : "";
      }
    }
  }

  const decisivePhoneFailure = input.preferKuaidi100
    ? accountError
    : k100Error;
  const phoneError = decisivePhoneFailure instanceof Error &&
      decisivePhoneFailure.message.includes("手机尾号")
    ? decisivePhoneFailure
    : !selected
      ? [k100Error, accountError].find(
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
      accountShipment?.identity.courierCode ||
      input.courierCode ||
      "",
    companyName:
      selected?.identity.companyName ||
      accountShipment?.identity.companyName ||
      input.companyName ||
      "",
    createdAtMs: now,
    lastAttemptAtMs: now,
    attempts: 1,
    route: selected?.route?.kind === "cainiao" ? selected.route : null,
  };
  if (k100Error instanceof Error && !/暂无轨迹|无法识别/.test(k100Error.message)) {
    if (!selected) throw k100Error;
  }
  return {
    shipment: selected,
    pending,
    routeUrl: selectedRouteUrl,
  };
}
