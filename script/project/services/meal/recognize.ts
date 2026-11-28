import type { MealRules } from "./rules";
import { visionBoundingBoxToOcrBlock, type VisionBoundingBox } from "./ocr-geometry";
import {
  cleanMerchant,
  contentBrand,
  normalizePickupText,
  onlineBrand,
  parseLuckinDraft,
  parsePickupCredentials,
  redemptionIdentity,
  redemptionPage,
} from "./pickup-parser";
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

function resolveRedemptionBrand(
  runtime: MealRules["parsed"],
  model?: Record<string, unknown>,
  candidates?: readonly Candidate[],
) {
  const rawBrand = model ? modelText(model, "brand", 256) : "";
  const code = model ? modelText(model, "pickupCode", 256) : "";
  const product = model ? modelText(model, "productName") : "";
  const spec = model ? modelText(model, "productSpec") : "";
  const merchant = model ? modelText(model, "merchantName") : "";
  if (model) {
    const explicit = onlineBrand(runtime, rawBrand, code, product, spec);
    if (explicit) return explicit.redemption ? explicit : undefined;
  }
  const candidateLines = (candidates ?? []).map(item => normalizePickupText(item.content)).filter(Boolean);
  const lines = [rawBrand, merchant, product, ...candidateLines].filter(Boolean);
  if (!lines.length) return undefined;
  const identity = redemptionIdentity(runtime, lines.join("\n"));
  if (!identity?.redemption) return undefined;
  const stripped = lines
    .filter(line => !identity.redemption?.username?.matches(line.trim()))
    .join("\n");
  const detected = contentBrand(runtime, stripped);
  if (detected) return detected.redemption ? detected : undefined;
  if (rawBrand && !identity.keywords.some(keyword => stripped.includes(keyword))) {
    return undefined;
  }
  return identity;
}

function hasRedemptionBrandCues(
  runtime: MealRules["parsed"],
  model?: Record<string, unknown>,
  candidates?: readonly Candidate[],
): boolean {
  const brand = resolveRedemptionBrand(runtime, model, candidates);
  if (!brand?.redemption) return false;
  const fieldLines = model
    ? ["brand", "merchantName", "productName", "productSpec", "waitTime", "status"]
        .map(key => modelText(model, key))
        .filter(Boolean)
    : [];
  const candidateLines = (candidates ?? []).map(item => normalizePickupText(item.content)).filter(Boolean);
  const combined = [...fieldLines, ...candidateLines].join("\n");
  if (!combined) return false;
  return combined.includes(brand.redemption.pageStatus) || EXPLICIT_REDEMPTION_CUE_PATTERN.test(combined);
}

export function onlineMealRequiresQR(
  fields: Record<string, unknown>,
  rules: MealRules,
  candidates?: readonly Candidate[],
): boolean {
  if (hasRedemptionBrandCues(rules.parsed, fields, candidates)) {
    return true;
  }
  const redemptionBrand = resolveRedemptionBrand(rules.parsed, fields, candidates);
  if (
    redemptionBrand &&
    (!modelText(fields, "pickupCode", 256).trim() || (candidates !== undefined && candidates.length === 0))
  ) {
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
  const candidateLines = (candidates ?? []).map(item => normalizePickupText(item.content)).filter(Boolean);
  const brand = onlineBrand(rules.parsed, name, code, product, spec)
    ?? (!name ? resolveRedemptionBrand(rules.parsed, fields, candidates) : undefined);
  const payload: MealPayload = {
    brandId: brand?.id ?? rules.parsed.genericBrandId, brandName: brand?.name ?? (name || rules.parsed.genericBrandName),
    code, merchantName: chineseParentheses(cleanMerchant(merchant, rules.parsed)),
    productName: productTitle(product), createdAt: capturedAt, expiresAt: capturedAt + rules.parsed.ttlSeconds * 1000,
    ...onlineMetadata(fields),
  };
  const specEvidence = spec ? (product ? `${product}\n${spec}` : spec) : candidateLines.join("\n");
  return mealObservation(payload, rules.raw, product, specEvidence);
}

export async function recognizeMealImage(image: UIImage, candidates: readonly Candidate[], capturedAt: number,
  rules: MealRules, model?: Record<string, unknown>) {
  const width = image.width * image.scale, height = image.height * image.scale;
  const joined = candidates.map(item => normalizePickupText(item.content)).join("\n");
  const tea = redemptionPage(rules.parsed, joined);
  const redemptionBrand = resolveRedemptionBrand(rules.parsed, model, candidates);
  const explicitRedemption = Boolean(
    tea ||
    hasRedemptionBrandCues(rules.parsed, model, candidates) ||
    (model && redemptionBrand && (!modelText(model, "pickupCode", 256).trim() || candidates.length === 0)),
  );
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
  const explicitRedemptionCues = Boolean(
    redemptionPage(rules.parsed, joined) ||
    hasRedemptionBrandCues(rules.parsed, model, candidates),
  );
  const requiresQr = Boolean(
    explicitRedemptionCues ||
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
  const usableParsed = explicitRedemptionCues
    ? parsed.filter(value => !rules.parsed.brandsById.get(value.brandId)?.redemption || Boolean(value.qrPayload))
    : parsed;
  if (usableParsed.length) {
    return { meals: usableParsed.map(value => observation(value, usableParsed.length === 1)) };
  }
  const modelRedemptionBrand = resolveRedemptionBrand(rules.parsed, model, candidates);
  if (
    modelRedemptionBrand?.redemption &&
    (explicitRedemptionCues || (model && (!modelText(model, "pickupCode", 256).trim() || candidates.length === 0)))
  ) {
    const cancelled = blocks.some(row => rules.parsed.cancellationStatus.finds(row.text));
    const decoded = qrPayloads.filter(value => Boolean(value.trim()));
    if (!cancelled && new Set(decoded).size === 1) {
      const onlineProduct = model ? modelText(model, "productName") : "";
      const onlineMerchant = model ? modelText(model, "merchantName") : "";
      const onlineSpec = model ? modelText(model, "productSpec") : "";
      const fallbackParsed = parsed[0];
      const payload: MealPayload = {
        brandId: modelRedemptionBrand.id,
        brandName: modelRedemptionBrand.name,
        code: "",
        merchantName: chineseParentheses(
          onlineMerchant ? cleanMerchant(onlineMerchant, rules.parsed) : (fallbackParsed?.merchantName ?? ""),
        ),
        productName: productTitle(onlineProduct || fallbackParsed?.productName || ""),
        createdAt: capturedAt,
        expiresAt: capturedAt + rules.parsed.ttlSeconds * 1000,
        status: "待核销",
        qrPayload: decoded[0],
        ...mealOrderMetadata(rules.raw, blocks, (model ? modelText(model, "waitTime", 128) : "") || fallbackParsed?.waitTime || ""),
        ...(model ? onlineMetadata(model) : {}),
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
