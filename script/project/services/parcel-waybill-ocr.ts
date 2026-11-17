import { PARCEL_WAYBILL_OCR as rules } from "../contracts/parcel-waybill-ocr.generated";

const shape = new RegExp(rules.shape);
const rejects = rules.rejectRegex.map((pattern) => new RegExp(pattern));
const label = new RegExp(rules.labelRegex, "g");
const numericWaybill = /^[A-Za-z]{0,4}\d{8,32}$/;

type Bounds = { left: number; right: number; top: number; bottom: number };
export type ParcelRow = { text: string; bounds?: Bounds };

export function isParcelWaybill(value: string): boolean {
  return shape.test(value) && rejects.every((pattern) => !pattern.test(value));
}

function negativeBefore(line: string, position: number): boolean {
  return rules.negLabels.some((name) => {
    const index = line.indexOf(name);
    return index >= 0 && index < position;
  });
}

function waybillCandidate(value: string, fromImage: boolean): string {
  if (fromImage && !numericWaybill.test(value)) {
    const repaired = value.replace(/[Oo]/g, "0");
    if (numericWaybill.test(repaired) && isParcelWaybill(repaired)) return repaired;
  }
  return isParcelWaybill(value) ? value : "";
}

function waybillsOnRow(row: ParcelRow): string[] {
  return Array.from(row.text.matchAll(/[A-Za-z0-9-]{6,}/g))
    .filter((match) => !negativeBefore(row.text, match.index))
    .map((match) => waybillCandidate(match[0], !!row.bounds))
    .filter(Boolean);
}

function height(bounds: Bounds): number {
  return bounds.bottom - bounds.top;
}

function center(bounds: Bounds): number {
  return (bounds.top + bounds.bottom) / 2;
}

function sameRow(first: Bounds, second: Bounds): boolean {
  return Math.abs(center(first) - center(second)) <= Math.min(height(first), height(second)) / 2;
}

function cleanRow(text: string): string {
  return text.trim().replace(/^[：:| ]+|[：:| ]+$/g, "");
}

export function parcelWaybillEvidence(rows: readonly ParcelRow[]): {
  waybill: string;
  candidateCount: number;
  carrierRow: number;
} {
  const labelled = new Set<string>();
  for (const row of rows) {
    for (const match of row.text.matchAll(label)) {
      if (negativeBefore(row.text, match.index)) continue;
      const value = waybillCandidate(match[1], !!row.bounds);
      if (value) labelled.add(value);
    }
    const bounds = row.bounds;
    // Pipi's split-label channel joins only values to the right of an approved label.
    if (bounds && rules.labels.some((name) => name === cleanRow(row.text))) {
      for (const candidate of rows) {
        if (candidate.bounds && candidate.bounds.left >= bounds.right && sameRow(bounds, candidate.bounds)) {
          waybillsOnRow(candidate).forEach((waybill) => labelled.add(waybill));
        }
      }
    }
  }
  const located = (values: Set<string>, carrierRow = -1) => ({
    waybill: values.size === 1 ? [...values][0] : "",
    candidateCount: values.size,
    carrierRow: values.size === 1 ? carrierRow : -1,
  });
  if (labelled.size) return located(labelled);

  const carriers = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!rules.carriers.some((name) => row.text.includes(name))) return;
    const [value] = waybillsOnRow(row);
    if (value && !carriers.has(value)) carriers.set(value, index);
  });
  if (carriers.size) return located(new Set(carriers.keys()), [...carriers.values()][0]);

  const copied = new Set<string>();
  rows.forEach((row, index) => {
    if (!row.text.includes(rules.copyWord) && cleanRow(rows[index + 1]?.text ?? "") !== rules.copyWord) return;
    const [value] = waybillsOnRow(row);
    if (value) copied.add(value);
  });
  return located(copied);
}

export function parcelTextRows(text: string): ParcelRow[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ text: line }));
}

export function recognizeParcelWaybill(text: string): string {
  return parcelWaybillEvidence(parcelTextRows(text)).waybill;
}

type VisionLine = {
  content: string;
  boundingBox: { x: number; y: number; width: number; height: number };
};

export function parcelImageRows(lines: readonly VisionLine[], width: number, heightPx: number): ParcelRow[] {
  const order = (a: Bounds, b: Bounds) => a.top - b.top || center(a) - center(b) || a.left - b.left;
  const fragments = lines.filter((line) => line.content.trim()).map(({ content, boundingBox: box }) => ({
    text: content.trim(),
    bounds: {
      left: Math.round(box.x * width),
      right: Math.round((box.x + box.width) * width),
      top: Math.round((1 - box.y - box.height) * heightPx),
      bottom: Math.round((1 - box.y) * heightPx),
    },
  })).sort((a, b) => order(a.bounds, b.bounds));
  const rows: { bounds: Bounds; fragments: typeof fragments }[] = [];
  for (const fragment of fragments) {
    const box = fragment.bounds;
    // The Android aggregator keeps a wide gutter separate from ordinary word spacing.
    const compatible = rows.filter(({ bounds, fragments }) => {
      const gap = Math.max(box.left - bounds.right, bounds.left - box.right, 0);
      return sameRow(fragments[0].bounds, box) && gap <= Math.max(24, Math.max(height(bounds), height(box)) / 2);
    }).sort((a, b) => Math.abs(center(a.fragments[0].bounds) - center(box)) -
      Math.abs(center(b.fragments[0].bounds) - center(box)))[0];
    if (!compatible) {
      rows.push({ bounds: box, fragments: [fragment] });
      continue;
    }
    compatible.fragments.push(fragment);
    const bounds = compatible.bounds;
    compatible.bounds = {
      left: Math.min(bounds.left, box.left), right: Math.max(bounds.right, box.right),
      top: Math.min(bounds.top, box.top), bottom: Math.max(bounds.bottom, box.bottom),
    };
  }
  return rows.sort((a, b) => order(a.bounds, b.bounds)).map(({ bounds, fragments }) => ({
    bounds,
    text: fragments.sort((a, b) => a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top)
      .map((fragment) => fragment.text).join(" "),
  }));
}
