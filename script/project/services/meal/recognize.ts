import type { MealRules } from "./rules";
import { visionBoundingBoxToOcrBlock, type VisionBoundingBox } from "./ocr-geometry";
import { cleanMerchant, normalizePickupText, onlineBrand, parseLuckinDraft, parsePickupCredentials, redemptionIdentity, redemptionPage } from "./pickup-parser";
import { resolvePickupVisualStyle } from "./pickup-artwork";
import { mealOrderMetadata } from "./order-metadata";
import type { MealObservation, MealPayload } from "./records";
import { readMealQRs } from "./qr";

export function chineseParentheses(value: string): string {
  const characters = value.split("");
  const opens: number[] = [];
  for (const [index, character] of characters.entries()) {
    if (character === "(") opens.push(index);
    if (character !== ")" || opens.length === 0) continue;
    const open = opens.pop()!;
    if (/\p{Script=Han}/u.test(value.slice(open + 1, index))) {
      characters[open] = "（";
      characters[index] = "）";
    }
  }
  return characters.join("");
}

function productTitle(value: string): string {
  return chineseParentheses(/[®™]/u.test(value)
    ? value.replace(/(?<= )[®™] /gu, "").replace(/[®™]/gu, "").trim() : value);
}

function modelText(fields: Record<string, unknown>, key: string, limit = 512) {
  const field = fields[key];
  const value = typeof field === "string" ? field.trim() : "";
  return value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value) ? value : "";
}

function onlineMetadata(fields: Record<string, unknown>): Pick<MealPayload, "waitTime" | "totalAmount" | "itemCount"> {
  const waitTime = modelText(fields, "waitTime", 128), totalAmount = modelText(fields, "totalAmount", 32);
  return { ...(waitTime ? { waitTime } : {}), ...(totalAmount ? { totalAmount } : {}),
    ...(typeof fields.itemCount === "number" ? { itemCount: fields.itemCount } : {}) };
}

export function onlineMealRequiresQR(fields: Record<string, unknown>, rules: MealRules): boolean {
  return Boolean(redemptionIdentity(rules.parsed, ["brand", "merchantName", "productName"].map(key => modelText(fields, key)).join("\n")));
}

export function mealFromModel(fields: Record<string, unknown>, capturedAt: number, rules: MealRules): MealObservation | null {
  const code = modelText(fields, "pickupCode", 256);
  if (!code) return null;
  const name = modelText(fields, "brand", 256);
  const product = modelText(fields, "productName");
  const spec = modelText(fields, "productSpec");
  const brand = onlineBrand(rules.parsed, name, code, product, spec);
  const payload: MealPayload = {
    brandId: brand?.id ?? rules.parsed.genericBrandId, brandName: brand?.name ?? (name || rules.parsed.genericBrandName),
    code, merchantName: chineseParentheses(cleanMerchant(modelText(fields, "merchantName"), rules.parsed)),
    productName: productTitle(product), createdAt: capturedAt, expiresAt: capturedAt + rules.parsed.ttlSeconds * 1000,
    ...onlineMetadata(fields),
  };
  return { payload, artwork: resolvePickupVisualStyle(rules.raw, {
    brandId: payload.brandId, productName: product, evidenceText: spec ? product + "\n" + spec : "",
  }) };
}

type Candidate = { content: string; boundingBox: VisionBoundingBox };
export async function recognizeMealImage(image: UIImage, candidates: readonly Candidate[], capturedAt: number,
  rules: MealRules, model?: Record<string, unknown>) {
  const width = image.width * image.scale, height = image.height * image.scale;
  const joined = candidates.map(item => normalizePickupText(item.content)).join("\n");
  const tea = redemptionPage(rules.parsed, joined);
  const qrPayloads = tea ? readMealQRs(image) : await QRCode.parseImage(image).then(value => value ? [value] : [], () => []);
  return recognizeMealText(candidates, width, height, capturedAt, qrPayloads, rules, model);
}

export function recognizeMealText(
  candidates: readonly Candidate[], width: number, height: number, capturedAt: number,
  qrPayloads: readonly string[], rules: MealRules, model?: Record<string, unknown>,
): { meals: MealObservation[]; draft?: MealObservation } {
  const blocks = candidates.map(candidate => visionBoundingBoxToOcrBlock(candidate.content, candidate.boundingBox, width, height));
  const input = { blocks, screenWidth: width, recognizedAtMs: capturedAt, rawBarcodes: qrPayloads };
  const parsed = parsePickupCredentials(input, rules.parsed);
  const evidenceText = blocks.map(block => block.text).join("\n");
  function observation(result: ReturnType<typeof parsePickupCredentials>[number], metadata: boolean): MealObservation {
    const verifiedOnlineQR = result.brandId === "chayanyuese" && result.qrPayload ? model : undefined;
    const onlineProduct = verifiedOnlineQR ? modelText(verifiedOnlineQR, "productName") : "";
    const onlineMerchant = verifiedOnlineQR ? modelText(verifiedOnlineQR, "merchantName") : "";
    const payload: MealPayload = {
      brandId: result.brandId, brandName: result.brandName, code: result.code,
      merchantName: chineseParentheses(onlineMerchant ? cleanMerchant(onlineMerchant, rules.parsed) : result.merchantName),
      productName: productTitle(onlineProduct || result.productName),
      createdAt: result.recognizedAtMs, expiresAt: result.expiresAtMs,
      ...(result.status ? { status: result.status } : {}),
      ...(result.qrPayload ? { qrPayload: result.qrPayload } : {}),
      ...(metadata ? mealOrderMetadata(rules.raw, blocks, result.waitTime)
        : result.waitTime ? { waitTime: result.waitTime } : {}),
      ...(verifiedOnlineQR ? onlineMetadata(verifiedOnlineQR) : {}),
    };
    return { payload, artwork: resolvePickupVisualStyle(rules.raw, {
      brandId: payload.brandId, productName: payload.productName ?? "", evidenceText,
    }) };
  }
  if (parsed.length) return { meals: parsed.map(value => observation(value, parsed.length === 1)) };
  const draft = !model ? parseLuckinDraft(input, rules.parsed) : undefined;
  return { meals: [], ...(draft ? { draft: observation(draft, true) } : {}) };
}
