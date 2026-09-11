import { resolveCarrierQuery, resolveCarrierCpCode } from "./carrier-query";
import { normalizeWaybill } from "./status";
import { TIMELINE_SLOT } from "./timeline-slot";

/** Carrier substitution belongs to the existing H5 stage, not to list eligibility. */
export function primaryH5Provider(courierCode: string): string {
  return (resolveCarrierQuery(courierCode) || resolveCarrierCpCode(courierCode))?.standardCode === "JTSD"
    ? TIMELINE_SLOT.JT_H5 : TIMELINE_SLOT.K100_H5;
}

export function primaryH5Route(waybill: string, courierCode: string): string {
  const normalized = normalizeWaybill(waybill);
  if (!normalized) return "";
  return primaryH5Provider(courierCode) === TIMELINE_SLOT.JT_H5
    ? "https://jtsd.jtexpress.com.cn/pipi#/pages/checkGoods/sendDetail?waybillNo=" +
      encodeURIComponent(normalized) + "&isFrom=serach"
    : "https://m.kuaidi100.com/app/query/?nu=" + encodeURIComponent(normalized);
}

/** An explicit parcel suffix is exclusive; only its absence permits bound candidates. */
export function webPhoneTails(explicit: string | undefined, bound: readonly string[] = []): string[] {
  const supplied = String(explicit || "").trim();
  const values = supplied ? [supplied] : bound;
  return [...new Set(values.filter(value => /^\d{4}$/.test(value)))];
}

export class WebTimelinePhoneError extends Error {
  readonly needsPhoneTail = true;
  readonly code = "phone_tail";
  constructor() { super("Phone suffix required"); }
}

export function needsManualPhoneTail(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "needsPhoneTail" in error && error.needsPhoneTail === true);
}

/** The official input event runs JT's own verification; no signing or request replay is used. */
export function jtH5JavaScript(waybill: string, phoneTails: readonly string[]): string {
  return `return (() => {
    const empty = {tracks: [], page: {}};
    const expected = ${JSON.stringify(normalizeWaybill(waybill))};
    const tails = ${JSON.stringify(phoneTails)};
    const clean = value => String(value == null ? '' : value).trim().replace(/\\s+/g, ' ');
    const url = new URL(location.href);
    const hash = url.hash.slice(1), split = hash.indexOf('?');
    if (url.protocol !== 'https:' || url.hostname !== 'jtsd.jtexpress.com.cn' ||
        (url.pathname !== '/pipi' && url.pathname !== '/pipi/') ||
        hash.slice(0, split) !== '/pages/checkGoods/sendDetail') return empty;
    const params = new URLSearchParams(hash.slice(split + 1));
    const numbers = params.getAll('waybillNo');
    if (!expected || numbers.length !== 1 || numbers[0] !== expected) return empty;
    const state = window.__pipiJtH5 || (window.__pipiJtH5 = {next: 0, awaiting: false});
    const input = document.querySelector('.query-popup input.uni-input-input');
    const challenged = !!(input && input.getClientRects().length);
    const page = {phoneChallengeVisible: challenged, phoneVerificationAttempted: state.next > 0,
      readyState: document.readyState, locationNuMatches: true};
    const output = {tracks: [], page};
    if (challenged) {
      if (!tails.length) { page.phoneFailure = 'required'; return output; }
      const toast = Array.from(document.querySelectorAll('.uni-toast__content'))
        .filter(node => node.getClientRects().length)
        .map(node => clean(node.textContent)).join(' ');
      const phoneWarning = /(手机|尾号|后四位|后4位)/.test(toast) &&
        /(错误|不匹配|不正确|有误|验证失败)/.test(toast);
      if (state.waitingForToastClear) {
        if (phoneWarning) return output;
        state.waitingForToastClear = false;
      }
      if (state.awaiting) {
        // A cleared form can also mean a service failure. Only an explicit phone error permits retry.
        if (input.value !== '') return output;
        if (!phoneWarning) return output;
        state.awaiting = false;
        if (state.next >= tails.length) { page.phoneFailure = 'rejected'; return output; }
        // Do not attribute this attempt's still-visible warning to the next candidate.
        state.waitingForToastClear = true;
        return output;
      }
      if (state.next < tails.length) {
        const tail = tails[state.next++];
        state.awaiting = true;
        page.phoneVerificationAttempted = true;
        input.value = tail;
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
      return output;
    }
    const header = document.querySelector('.scft-left .cgsllt-right');
    if (clean(header && header.textContent) !== expected) return output;
    for (const row of Array.from(document.querySelectorAll('.scd-route .scdr-list')).slice(0, 100)) {
      const time = row.querySelector('.scdrlr-time');
      const right = row.querySelector('.scdrl-right');
      const status = row.querySelector('.scdrl-left');
      if (!time || !right) continue;
      const context = Array.from(right.children).filter(child => !child.classList.contains('scdrlr-time'))
        .map(child => child.textContent || '').join('');
      const detail = clean([clean(status && status.textContent), clean(context)].filter(Boolean).join(' '));
      const timeText = clean(time.textContent);
      if (timeText && detail) output.tracks.push({timeText, detail});
    }
    return output;
  })();`;
}
