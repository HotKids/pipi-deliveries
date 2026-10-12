import type { Shipment } from "../models";
import {
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierName,
  resolveCarrierQuery,
} from "./carrier-query";
import { carrierRecognitionExhausted } from "./carrier-recognition";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";

type CarrierEvidence = "matched" | "blank" | "platform_label" | "raw_code";

function carrierEvidence(shipment: Shipment): CarrierEvidence {
  if (unprojectedAccountOrder(shipment)) return "matched";
  const waybill = displayWaybill(shipment);
  if (!waybill) return "matched";
  const identity = shipment.identity;
  const name = String(identity.companyName || "").trim();
  if (!name) return "blank";
  const code = normalizeCarrierCode(identity.courierCode || "");
  const nameRecord = resolveCarrierName(name);
  const codeRecord = code ? resolveCarrierQuery(code) || resolveCarrierCpCode(code) : null;
  const jingDongBusiness = !identity.manuallyAdded &&
    String(identity.sourceProvider || "").trim().toLowerCase() === "jingdong";
  if (jingDongBusiness && !/^JD/i.test(waybill) &&
      (nameRecord || codeRecord)?.standardCode === "JD") return "platform_label";
  if (nameRecord || codeRecord) return "matched";
  // The raw codes this row carries: its own, and the source record's (for an account order that is the order's own code,
  // which stays with the row after projection while a recognised feed-text waybill clears `rawCourierCode`).
  const shownAsCode = normalizeCarrierCode(name);
  const rawCodes = [
    code,
    normalizeCarrierCode(identity.rawCourierCode || ""),
    normalizeCarrierCode(shipment.accountRecord?.companyCode || ""),
  ].filter(Boolean);
  return shownAsCode && rawCodes.includes(shownAsCode) ? "raw_code" : "matched";
}

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：这一行已经亮出真实运单号，承运商却还没对上。
 *
 * 没对上指：可见的承运商名为空；或京东业务来源的自动行、运单号不以 JD 开头，名字或码只解析成京东（R-20 平台标签，
 * 不是承运商证据）；或名字只是原样搬过来的原始码（内置表认不出）。上游、京粉页或 Picker 给的真名照旧算承运商。
 * 未投影的订单显示「京东购物」，不在此列。之后的轮次对这样的行继续补识别。
 */
export function carrierUnmatched(shipment: Shipment): boolean {
  return carrierEvidence(shipment) !== "matched";
}

/**
 * 没对上、且还要等识别的行：不推送、不排队带空白承运商的通知，识别出来那一轮再推。
 *
 * 其余裁决 32、33（用户 2026-09-26）：识别已进入终态（连续 3 次失败，或付费级明确认不出，且快递100 没给名字）时不再无限期
 * 挂着——承运商位置填来源传回的承运商码原样照常放行，来源没传回就空着放行（「传回啥 cpcode 就填啥」），不自造占位文案。
 * 仍显示 R-20 平台名的行等下一轮把平台名换成原始码。
 */
export function carrierAwaitingRecognition(shipment: Shipment): boolean {
  const evidence = carrierEvidence(shipment);
  if (evidence === "matched") return false;
  if (evidence === "raw_code" || evidence === "blank") {
    return !carrierRecognitionExhausted(displayWaybill(shipment));
  }
  return true;
}
