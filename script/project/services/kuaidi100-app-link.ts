import { normalizeWaybill } from "./status";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import type { AccountBinding, Shipment } from "../models";
import { SCRIPT_BINDING_SOURCE } from "./script-source";

export function kuaidi100MiniProgramURL(waybill: string): string {
  const normalized = normalizeWaybill(waybill);
  if (!normalized) return "";
  const query = encodeURIComponent(`nu=${normalized}&querysource=third_xcx`);
  return `weixin://dl/business/?appid=wx6885acbedba59c14&path=pages/result/result&query=${query}&env_version=release`;
}

/** Source App capability is independent of whether its current route can be resolved. */
export function accountKuaidi100URL(
  shipment: Shipment, current: Shipment | undefined,
  binding: AccountBinding | undefined, currentBinding: AccountBinding | undefined,
): string {
  if (!current || shipment.identity.id !== current.identity.id ||
    shipment.identity.manuallyAdded || current.identity.manuallyAdded ||
    shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE ||
    current.identity.bindingSource !== shipment.identity.bindingSource ||
    current.identity.sourceOwner !== shipment.identity.sourceOwner ||
    Boolean(current.identity.accountOrder) !== Boolean(shipment.identity.accountOrder) ||
    unprojectedAccountOrder(shipment) || unprojectedAccountOrder(current)) return "";
  const previous = shipment.accountRecord;
  const record = current.accountRecord;
  if (!previous || !record || !binding || !currentBinding ||
    binding.source !== SCRIPT_BINDING_SOURCE || currentBinding.source !== binding.source ||
    binding.phone !== record.phone || currentBinding.phone !== binding.phone ||
    binding.boundAtMs !== currentBinding.boundAtMs) return "";
  const provider = String(current.identity.sourceProvider || "").trim().toLowerCase();
  if (!provider || [shipment.identity.sourceProvider, previous.provider, record.provider]
      .some(value => String(value || "").trim().toLowerCase() !== provider) ||
    ["jingdong", "cainiao", "shunfeng"].includes(provider) ||
    previous.companyCode !== record.companyCode || previous.phone !== record.phone ||
    normalizeWaybill(previous.waybill) !== normalizeWaybill(record.waybill) ||
    normalizeWaybill(shipment.identity.sourceId) !== normalizeWaybill(current.identity.sourceId) ||
    normalizeWaybill(current.identity.sourceId) !== normalizeWaybill(record.waybill)) return "";
  const waybill = normalizeWaybill(displayWaybill(current));
  if (!waybill || waybill !== normalizeWaybill(displayWaybill(shipment)) ||
    !current.identity.accountOrder && waybill !== normalizeWaybill(record.waybill)) return "";
  return kuaidi100MiniProgramURL(waybill);
}

export function shunfengKuaidi100FallbackURL(shipment: Shipment, current: Shipment | undefined): string {
  if (!current || shipment.identity.id !== current.identity.id ||
    shipment.identity.manuallyAdded || current.identity.manuallyAdded ||
    shipment.identity.accountOrder || current.identity.accountOrder ||
    shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE ||
    shipment.identity.bindingSource !== current.identity.bindingSource ||
    shipment.identity.sourceOwner !== current.identity.sourceOwner ||
    String(shipment.identity.sourceProvider || "").toLowerCase() !== "shunfeng" ||
    String(current.identity.sourceProvider || "").toLowerCase() !== "shunfeng") return "";
  const previous = shipment.accountRecord;
  const record = current.accountRecord;
  const waybill = normalizeWaybill(displayWaybill(current));
  if (!previous || !record || !waybill ||
    String(record.provider).toLowerCase() !== "shunfeng" ||
    String(previous.provider).toLowerCase() !== "shunfeng" ||
    previous.companyCode !== record.companyCode || previous.phone !== record.phone ||
    normalizeWaybill(previous.waybill) !== normalizeWaybill(record.waybill) ||
    normalizeWaybill(shipment.identity.sourceId) !== normalizeWaybill(current.identity.sourceId) ||
    normalizeWaybill(current.identity.sourceId) !== waybill ||
    waybill !== normalizeWaybill(displayWaybill(shipment)) ||
    waybill !== normalizeWaybill(record.waybill)) return "";
  return kuaidi100MiniProgramURL(waybill);
}
