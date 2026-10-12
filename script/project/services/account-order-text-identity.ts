/**
 * The carrier waybill that Xiaomi's own JD order track text already names, e.g.
 * "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547".
 * When present it is read directly and the H5 projection is skipped; JD-fulfilled orders
 * whose text never names a waybill keep going through the H5 projection.
 *
 * Only the waybill is read (user decision 2026-09-26, 其余裁决 7): the carrier named in the same
 * sentence is not carrier evidence. The carrier then comes from the built-in table, the free Kuaidi100
 * recognition and the existing paid fallback, like every other real waybill.
 */
export type AccountOrderTextIdentity = Readonly<{
  waybill: string;
}>;

const WAYBILL_PATTERN = /运单号\s*[为是:：]?\s*([A-Za-z0-9-]{8,32})/;

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
    return { waybill };
  }
  return null;
}
