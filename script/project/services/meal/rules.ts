import { SCRIPT_BUILD_TRACK } from "../build-track";
import { gatewayCredentialForLocalCache } from "../credentials";
import { savedKeyActivatedElsewhere } from "../scripting-activation";
import { sha256Hex } from "../scripting-data";
import { createPickupRuntime, type PickupRuntime } from "./pickup-runtime";

const MAX_RULE_BYTES = 256 * 1024;

export type MealRuleOffer = Readonly<{ sha256: string; pack: string }>;
export type MealRules = Readonly<{ raw: unknown; parsed: PickupRuntime }>;
let compiled: { offer: MealRuleOffer; rules: MealRules } | undefined;

/**
 * The Access Key scope meal codes and their rules belong to. Only the formal Worker serves the meal rule pack and
 * the meal record routes, so a beta build has none, like activeWatchScope (N3, 2026-11-21): it neither asks for the
 * rules on every meal pull nor pulls meal records.
 */
export function mealCredentialScope(): string {
  if (SCRIPT_BUILD_TRACK !== "formal") return "";
  const credential = gatewayCredentialForLocalCache();
  return credential && !credential.rejected && !savedKeyActivatedElsewhere() ? credential.scope : "";
}

export function parseMealRuleOffer(value: unknown): MealRuleOffer | null {
  const candidate = value as Partial<MealRuleOffer> | undefined;
  return candidate && typeof candidate.sha256 === "string" && /^[0-9a-f]{64}$/.test(candidate.sha256) &&
    typeof candidate.pack === "string" && candidate.pack.length > 0 && candidate.pack.length <= MAX_RULE_BYTES
    ? { sha256: candidate.sha256, pack: candidate.pack } : null;
}

export function compileMealRules(offer: MealRuleOffer): MealRules | null {
  if (compiled?.offer.sha256 === offer.sha256 && compiled.offer.pack === offer.pack) return compiled.rules;
  try {
    if (sha256Hex(offer.pack) !== offer.sha256) return null;
    const raw: unknown = JSON.parse(offer.pack);
    const rules = { raw, parsed: createPickupRuntime(raw) };
    compiled = { offer, rules };
    return rules;
  } catch { return null; }
}
