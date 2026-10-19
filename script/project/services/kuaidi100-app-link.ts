import { normalizeWaybill } from "./status";
import { displayWaybill } from "./shipment-policy";
import type { Shipment } from "../models";
import { SCRIPT_BINDING_SOURCE } from "./script-source";

export function kuaidi100MiniProgramURL(waybill: string): string {
  const normalized = normalizeWaybill(waybill);
  if (!normalized) return "";
  const query = encodeURIComponent(`nu=${normalized}&querysource=third_xcx`);
  return `weixin://dl/business/?appid=wx6885acbedba59c14&path=pages/result/result&query=${query}&env_version=release`;
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
