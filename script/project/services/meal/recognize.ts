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

function mealObservation(payload: MealPayload, rawRules: MealRules["raw"], product: string, evidenceText: string): MealObservation {
  const artwork = resolvePickupVisualStyle(rawRules, { brandId: payload.brandId, productName: product, evidenceText });
  return { payload: artwork.drinkTemperature ? { ...payload, drinkTemperature: artwork.drinkTemperature } : payload, artwork };
}

type Candidate = { content: string; boundingBox: VisionBoundingBox };

const EXPLICIT_REDEMPTION_CUE_PATTERN = /待扫码核销|扫码核销|请出示二维码|出示二维码|核销二维码|请扫码核销/u;

function hasExplicitRedemptionCues(text: string, runtime: MealRules["parsed"]): boolean {
  if (!text) return false;
  if (redemptionPage(runtime, text)) return true;
  return EXPLICIT_REDEMPTION_CUE_PATTERN.test(text);
}

export function onlineMealRequiresQR(
  fields: Record<string, unknown>,
  rules: MealRules,
  candidates?: readonly Candidate[],
): boolean {
  const fieldLines = ["brand", "merchantName", "productName", "productSpec", "waitTime", "status"]
    .map(key => modelText(fields, key))
    .filter(Boolean);
  const candidateLines = (candidates ?? []).map(item => normalizePickupText(item.content)).filter(Boolean);
  const combined = [...fieldLines, ...candidateLines].join("\n");
  if (hasExplicitRedemptionCues(combined, rules.parsed)) {
    return true;
  }
  if (!modelText(fields, "pickupCode", 256).trim()
      && redemptionIdentity(rules.parsed, ["brand", "merchantName", "productName"].map(key => modelText(fields, key)).join("\n"))) {
    return true;
  }
  const brand = onlineBrand(
    rules.parsed,
    modelText(fields, "brand", 256),
    modelText(fields, "pickupCode", 256),
    modelText(fields, "productName"),
    modelText(fields, "productSpec"),
  );
  return brand?.id === "ruixing";
}

export function mealFromModel(
  fields: Record<string, unknown>,
  capturedAt: number,
  rules: MealRules,
  candidates?: readonly Candidate[],
): MealObservation | null {
  const code = modelText(fields, "pickupCode", 256);
  if (!code) return null;
  const name = modelText(fields, "brand", 256);
  const merchant = modelText(fields, "merchantName");
  const product = modelText(fields, "productName");
  const spec = modelText(fields, "productSpec");
  const joined = [
    merchant,
    product,
    ...(candidates ?? []).map(item => normalizePickupText(item.content)),
  ].filter(Boolean).join("\n");
  const brand = onlineBrand(rules.parsed, name, code, product, spec)
    ?? (!name ? redemptionIdentity(rules.parsed, joined) : undefined);
  const payload: MealPayload = {
    brandId: brand?.id ?? rules.parsed.genericBrandId, brandName: brand?.name ?? (name || rules.parsed.genericBrandName),
    code, merchantName: chineseParentheses(cleanMerchant(merchant, rules.parsed)),
    productName: productTitle(product), createdAt: capturedAt, expiresAt: capturedAt + rules.parsed.ttlSeconds * 1000,
    ...onlineMetadata(fields),
  };
  return mealObservation(payload, rules.raw, product, spec ? product + "\n" + spec : "");
}

export async function recognizeMealImage(image: UIImage, candidates: readonly Candidate[], capturedAt: number,
  rules: MealRules, model?: Record<string, unknown>) {
  const width = image.width * image.scale, height = image.height * image.scale;
  const joined = candidates.map(item => normalizePickupText(item.content)).join("\n");
  const tea = redemptionPage(rules.parsed, joined);
  const explicitRedemption = Boolean(tea || hasExplicitRedemptionCues(joined, rules.parsed));
  if (model && !explicitRedemption && !onlineMealRequiresQR(model, rules, candidates) && modelText(model, "pickupCode", 256)) {
    return recognizeMealText(candidates, width, height, capturedAt, [], rules, model);
  }
  const qrPayloads = explicitRedemption
    ? readMealQRs(image)
    : await QRCode.parseImage(image).then(value => value ? [value] : [], () => []);
  return recognizeMealText(candidates, width, height, capturedAt, qrPayloads, rules, model);
}

export function recognizeMealText(
  candidates: readonly Candidate[], width: number, height: number, capturedAt: number,
  qrPayloads: readonly string[], rules: MealRules, model?: Record<string, unknown>,
): { meals: MealObservation[]; draft?: MealObservation } {
  const joined = candidates.map(item => normalizePickupText(item.content)).join("\n");
  const requiresQr = Boolean(
    hasExplicitRedemptionCues(joined, rules.parsed) ||
    (model && onlineMealRequiresQR(model, rules, candidates)),
  );
  if (model && !requiresQr) {
    const fromModel = mealFromModel(model, capturedAt, rules, candidates);
    if (fromModel) return { meals: [fromModel] };
  }
  const blocks = candidates.map(candidate => visionBoundingBoxToOcrBlock(candidate.content, candidate.boundingBox, width, height));
  const input = { blocks, screenWidth: width, recognizedAtMs: capturedAt, rawBarcodes: qrPayloads };
  const parsed = parsePickupCredentials(input, rules.parsed);
  const evidenceText = blocks.map(block => block.text).join("\n");
  function observation(result: ReturnType<typeof parsePickupCredentials>[number], metadata: boolean): MealObservation {
    const verifiedOnlineQR = (result.brandId === "chayanyuese" || result.brandId === "ruixing") && result.qrPayload
      ? model : undefined;
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
    return mealObservation(payload, rules.raw, payload.productName ?? "", evidenceText);
  }
  if (parsed.length) return { meals: parsed.map(value => observation(value, parsed.length === 1)) };
  if (model && hasExplicitRedemptionCues(
    [joined, ...["brand", "merchantName", "productName", "productSpec", "waitTime", "status"].map(k => modelText(model, k))]
      .filter(Boolean)
      .join("\n"),
    rules.parsed,
  )) {
    const decoded = qrPayloads.filter(value => Boolean(value.trim()));
    const modelBrand = onlineBrand(
      rules.parsed,
      modelText(model, "brand", 256),
      modelText(model, "pickupCode", 256),
      modelText(model, "productName"),
      modelText(model, "productSpec"),
    ) ?? redemptionIdentity(
      rules.parsed,
      [joined, modelText(model, "brand"), modelText(model, "merchantName"), modelText(model, "productName")].filter(Boolean).join("\n"),
    );
    if (modelBrand?.redemption && new Set(decoded).size === 1) {
      const onlineProduct = modelText(model, "productName");
      const onlineMerchant = modelText(model, "merchantName");
      const onlineSpec = modelText(model, "productSpec");
      const payload: MealPayload = {
        brandId: modelBrand.id,
        brandName: modelBrand.name,
        code: "",
        merchantName: chineseParentheses(cleanMerchant(onlineMerchant, rules.parsed)),
        productName: productTitle(onlineProduct),
        createdAt: capturedAt,
        expiresAt: capturedAt + rules.parsed.ttlSeconds * 1000,
        status: "待核销",
        qrPayload: decoded[0],
        ...mealOrderMetadata(rules.raw, blocks, modelText(model, "waitTime", 128)),
        ...onlineMetadata(model),
      };
      return {
        meals: [mealObservation(payload, rules.raw, payload.productName ?? "", [evidenceText, onlineSpec].filter(Boolean).join("\n"))],
      };
    }
  }
  const allowLuckinDraft = !model || onlineBrand(
    rules.parsed,
    modelText(model, "brand", 256),
    modelText(model, "pickupCode", 256),
    modelText(model, "productName"),
    modelText(model, "productSpec"),
  )?.id === "ruixing";
  const draft = allowLuckinDraft ? parseLuckinDraft(input, rules.parsed) : undefined;
  return { meals: [], ...(draft ? { draft: observation(draft, true) } : {}) };
}
