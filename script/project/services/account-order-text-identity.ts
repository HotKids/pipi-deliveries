import { builtInCarrierPresentation } from "./carrier-presentation";

/**
 * Carrier identity that Xiaomi's own JD order track text already names, e.g.
 * "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547".
 * When present it is read directly and the H5 projection is skipped; JD-fulfilled orders
 * whose text never names a waybill keep going through the H5 projection.
 */
export type AccountOrderTextIdentity = Readonly<{
  waybill: string;
  courierCode: string;
  companyName: string;
}>;

const WAYBILL_PATTERN = /运单号\s*[为是:：]?\s*([A-Za-z0-9-]{8,32})/;
const CARRIER_BEFORE_WAYBILL =
  /(?:交付|交由|移交|转交|由)\s*([一-龥A-Za-z0-9]{2,16}?)\s*[，,、。；;]?\s*运单号/;

function normalize(value: string): string {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

export function accountOrderTextIdentity(
  tracks: readonly { detail: string }[] | null | undefined,
): AccountOrderTextIdentity | null {
  for (const track of tracks || []) {
    const detail = String(track?.detail || "");
    const match = WAYBILL_PATTERN.exec(detail);
    if (!match) continue;
    const waybill = normalize(match[1]);
    if (!/^[A-Z0-9-]{8,32}$/.test(waybill) || /^[0-9]+$/.test(waybill) && waybill.length > 20) continue;
    const carrierMatch = CARRIER_BEFORE_WAYBILL.exec(detail);
    const rawCarrier = carrierMatch ? carrierMatch[1].trim() : "";
    const presentation = rawCarrier ? builtInCarrierPresentation(rawCarrier) : null;
    return {
      waybill,
      courierCode: presentation?.courierCode || "",
      companyName: presentation?.companyName || rawCarrier,
    };
  }
  return null;
}
