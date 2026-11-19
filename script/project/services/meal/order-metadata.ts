import { PickupPattern } from "./pickup-runtime";
import { normalizePickupText } from "./pickup-parser";
import type { PickupOcrBlock } from "./pickup-types";
import type { MealPayload } from "./records";

type MetadataRules = {
  itemCountMaximum: number;
  amountMaximumLength: number;
  amountValuePattern: string;
  waitTimeClockPattern: string;
  waitTimePatterns: string[];
  itemCountPatterns: string[];
  totalAmountPatterns: string[];
  nonOrderTotalLinePatterns: string[];
};

function unique(
  lines: readonly string[], patterns: readonly string[], identity: (value: string) => string | null,
  prioritized = false,
): string {
  const values = new Map<string, string>();
  for (const source of patterns) {
    const pattern = new PickupPattern(source, "orderMetadata");
    let matched = false;
    for (const line of lines) {
      for (const value of pattern.extractAll(line, 1)) {
        const key = identity(value);
        if (key === null) return "";
        if (!values.has(key)) values.set(key, value);
        matched = true;
      }
    }
    if (prioritized && matched) break;
  }
  return values.size === 1 ? values.values().next().value ?? "" : "";
}

export function mealOrderMetadata(raw: unknown, blocks: readonly PickupOcrBlock[], waitTime: string):
  Pick<MealPayload, "waitTime" | "itemCount" | "totalAmount"> {
  const source = (raw as { orderMetadata?: MetadataRules }).orderMetadata;
  if (!source) return waitTime ? { waitTime } : {};
  const lines = blocks.map(block => normalizePickupText(block.text));
  const clock = new PickupPattern(source.waitTimeClockPattern, "orderMetadata.waitTimeClockPattern");
  const time = waitTime || unique(lines, source.waitTimePatterns, raw =>
    clock.matches(raw) ? raw.padStart(5, "0") : null);
  const count = unique(lines, source.itemCountPatterns, raw => {
    const amount = Number(raw);
    return Number.isSafeInteger(amount) && amount > 0 && amount <= source.itemCountMaximum ? String(amount) : null;
  });
  const currency = new PickupPattern(source.amountValuePattern, "orderMetadata.amountValuePattern");
  const excluded = source.nonOrderTotalLinePatterns.map(rule => new PickupPattern(rule, "orderMetadata.nonOrderTotalLinePatterns"));
  const total = unique(lines.filter(line => !excluded.some(rule => rule.finds(line))),
    source.totalAmountPatterns, raw => {
      if (raw.length > source.amountMaximumLength || !currency.matches(raw)) return null;
      const [whole, fraction = ""] = raw.split(".");
      return whole.replace(/^0+(?=\d)/u, "") + "." + fraction.padEnd(2, "0");
    }, true);
  return { ...(time ? { waitTime: time } : {}), ...(count ? { itemCount: Number(count) } : {}),
    ...(total ? { totalAmount: total } : {}) };
}
