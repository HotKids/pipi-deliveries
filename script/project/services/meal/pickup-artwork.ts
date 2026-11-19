type JsonObject = Record<string, unknown>
export type MealTemperature = "hot" | "cold"

export type PickupVisualStyle = {
  readonly artworkAsset: string
  readonly stickerAsset: string
  readonly stickerScale: number
  readonly buttonColor: string
  readonly buttonForegroundColor: string
  readonly codeColor: string
  readonly gradientStartColor: string
  readonly gradientEndColor: string
  readonly category: string
  readonly drinkTemperature?: MealTemperature
  readonly temperaturePair?: { hot: string; cold: string }
}

export type PickupVisualInput = {
  readonly brandId: string
  readonly productName: string
  readonly evidenceText: string
  readonly drinkTemperature?: MealTemperature
}

type ResolvedArtwork = {
  readonly backgroundAsset: string
  readonly aodAsset: string
}

const CARD_GRADIENT_START = 0xff22262d
const CARD_GRADIENT_END = 0xff38232d
const EMBEDDED_BRAND_IDS = new Set(["kendeji", "maidanglao", "tustin"])
const LEGACY_EMBEDDED_BRAND_ART = [
  "_takeout_kendeji",
  "_takeout_maidanglao",
  "_takeout_tustin",
] as const

export function resolvePickupVisualStyle(
  rawRuntime: unknown,
  input: PickupVisualInput,
): PickupVisualStyle {
  const runtime = objectAt(rawRuntime, "pickup runtime")
  const unknown = objectField(runtime, "unknownBrandDefaults")
  const brands = arrayAt(runtime, "brands").map((value, index) =>
    objectAt(value, `brands[${index}]`))
  const brandId = clean(input.brandId)
  const brand = brands.find((candidate) => clean(candidate.id) === brandId)

  const styleText = clean(input.productName) || clean(input.evidenceText)
  const temperatureText = clean(input.evidenceText) || styleText
  const category = brand
    ? clean(brand.category)
    : categoryFromText(runtime, styleText)
  const temperature = input.drinkTemperature ?? resolveTemperature(runtime, temperatureText)
  const artwork = resolveArtwork(runtime, unknown, brand, category, styleText, temperature)
  const temperaturePair = temperature === "unknown"
    ? validatedTemperaturePair(artwork,
      resolveArtwork(runtime, unknown, brand, category, styleText, "hot"),
      resolveArtwork(runtime, unknown, brand, category, styleText, "cold"))
    : undefined

  const unknownColors = optionalObject(unknown.colors)
  const unknownButton = androidColor(unknownColors.buttonBg, 0xff000000)
  const unknownCode = androidColor(unknownColors.codeColor, 0xffffffff)
  const unknownCard = androidColor(unknownColors.cardBg, 0x00000000)
  const brandPalette = brand ? optionalObjectOrNull(brand.palette) : null
  const button = brandPalette
    ? androidColor(brandPalette.buttonBg, 0xff000000)
    : unknownButton
  const code = brandPalette
    ? androidColor(brandPalette.codeColor, 0xffffffff)
    : unknownCode
  const card = brandPalette
    ? androidColor(brandPalette.cardBg, 0x00000000)
    : unknownCard

  const assets = brand ? optionalObject(brand.assets) : {}
  const rawSticker = Object.prototype.hasOwnProperty.call(assets, "artworkSticker")
    ? clean(assets.artworkSticker)
    : clean(assets.sticker)
  const artworkAsset = temperaturePair?.cold ?? assetBasename(artwork.aodAsset)
  const stickerAsset = shouldOverlayPickupBrand(brandId, artworkAsset)
    ? assetBasename(rawSticker)
    : ""

  return {
    artworkAsset,
    stickerAsset,
    stickerScale: stickerScale(assets.stickerScale),
    buttonColor: rgbHex(button),
    buttonForegroundColor: computeLuminance(button) > 0.52
      ? "#000000"
      : "#FFFFFF",
    codeColor: rgbHex(code),
    gradientStartColor: rgbHex(alphaBlend(card, CARD_GRADIENT_START)),
    gradientEndColor: rgbHex(alphaBlend(card, CARD_GRADIENT_END)),
    category,
    ...(temperature !== "unknown" ? { drinkTemperature: temperature } : {}),
    ...(temperaturePair ? { temperaturePair } : {}),
  }
}

function validatedTemperaturePair(current: ResolvedArtwork, hot: ResolvedArtwork, cold: ResolvedArtwork) {
  const shapes = [hot, cold].map(({ backgroundAsset, aodAsset }) => ({
    background: assetBasename(backgroundAsset), still: assetBasename(aodAsset),
  }))
  const [warm, iced] = shapes
  if (!warm.background || !iced.background || !warm.still || !iced.still ||
      warm.background === iced.background || warm.still === iced.still) return undefined
  if (!shapes.some(variant => variant.background === assetBasename(current.backgroundAsset) &&
      variant.still === assetBasename(current.aodAsset))) return undefined
  return { hot: warm.still, cold: iced.still }
}

export function alternateMealArtwork(style: PickupVisualStyle | undefined): string | undefined {
  if (style?.drinkTemperature) return undefined
  const pair = style?.temperaturePair
  if (!pair?.hot || !pair.cold || pair.hot === pair.cold) return undefined
  if (style?.artworkAsset === pair.hot) return pair.cold
  return style?.artworkAsset === pair.cold ? pair.hot : undefined
}

export function shouldOverlayPickupBrand(brandId: string, artAsset: string): boolean {
  const brand = clean(brandId).toLowerCase()
  const asset = clean(artAsset).toLowerCase()
  if (EMBEDDED_BRAND_IDS.has(brand)) return false
  return !LEGACY_EMBEDDED_BRAND_ART.some((marker) => asset.includes(marker))
}

function resolveArtwork(
  runtime: JsonObject,
  unknown: JsonObject,
  brand: JsonObject | undefined,
  category: string,
  styleText: string,
  temperature: ReturnType<typeof resolveTemperature>,
): ResolvedArtwork {
  const assets = brand ? optionalObject(brand.assets) : {}
  const fixedBackground = clean(assets.baseBg)
  if (fixedBackground) {
    return {
      backgroundAsset: fixedBackground,
      aodAsset: clean(assets.aod),
    }
  }

  const styleConfig = optionalObject(runtime.styleConfig)
  const categoryStyle = optionalObjectOrNull(styleConfig[category])
  if (categoryStyle) {
    const rules = optionalArray(categoryStyle.styles).map((value, index) =>
      objectAt(value, `styleConfig.${category}.styles[${index}]`))

    for (const rule of rules) {
      const ruleBrand = clean(rule.brand)
      if (!ruleBrand || !brand || !matchesRuleBrand(brand, ruleBrand)) continue
      const keywords = strings(rule.keywords)
      if (keywords.length > 0) {
        if (containsAny(styleText, keywords)) return ruleArtwork(rule)
      } else if (clean(rule.drinkTemperature) === temperature) {
        return ruleArtwork(rule)
      }
    }

    const commonHot = clean(categoryStyle.commonStyleHot)
    const commonCold = clean(categoryStyle.commonStyleCold)
    let bestRule: JsonObject | undefined
    let bestLength = 0
    for (const rule of rules) {
      if (clean(rule.brand)) continue
      if (
        temperature === "hot"
        && clean(rule.drinkTemperature) !== "hot"
        && rule.special !== true
      ) continue
      const background = clean(rule.image)
      if (
        temperature === "unknown"
        && (background === commonCold || background === commonHot)
      ) continue
      for (const keyword of strings(rule.keywords)) {
        if (containsIgnoreCase(styleText, keyword) && keyword.length > bestLength) {
          bestRule = rule
          bestLength = keyword.length
        }
      }
    }
    if (bestRule) return ruleArtwork(bestRule)
    return temperature === "cold"
      ? {
          backgroundAsset: commonCold,
          aodAsset: clean(categoryStyle.aodStaticCommonCold),
        }
      : {
          backgroundAsset: commonHot,
          aodAsset: clean(categoryStyle.aodStaticCommonHot),
        }
  }

  const cups = optionalObject(unknown.cupByCategory)
  const aods = optionalObject(unknown.aodByCategory)
  const cupDefault = optionalObject(cups[category])
  const aodDefault = optionalObject(aods[category])
  const temperatureKey = temperature === "cold" ? "cold" : "hot"
  return {
    backgroundAsset: clean(cupDefault[temperatureKey]),
    aodAsset: clean(aodDefault[temperatureKey]),
  }
}

function categoryFromText(runtime: JsonObject, source: string): string {
  const unknown = objectField(runtime, "unknownBrandDefaults")
  const categoryKeywords = optionalObject(unknown.categoryKeywords)
  const lower = clean(source).toLowerCase()
  for (const category of ["coffee", "tea"] as const) {
    for (const keyword of strings(categoryKeywords[category])) {
      if (lower.includes(keyword.toLowerCase())) return category
    }
  }
  return "catering"
}

function resolveTemperature(runtime: JsonObject, source: string): "cold" | "hot" | "unknown" {
  const hotCold = optionalObject(runtime.hotColdKeywords)
  let value = clean(source)
  for (const ingredient of strings(hotCold.ingredient_strip)) {
    value = value.split(ingredient).join("")
  }
  if (containsAny(value, strings(hotCold.cold))) return "cold"
  if (containsAny(value, strings(hotCold.hot))) return "hot"
  return "unknown"
}

function matchesRuleBrand(brand: JsonObject, ruleBrand: string): boolean {
  if (containsIgnoreCase(clean(brand.name), ruleBrand)) return true
  if (clean(brand.id).toLowerCase() === ruleBrand.toLowerCase()) return true
  if (strings(brand.keywords).some((value) => value.toLowerCase() === ruleBrand.toLowerCase())) {
    return true
  }
  return strings(brand.miniLabels)
    .some((value) => value.toLowerCase() === ruleBrand.toLowerCase())
}

function ruleArtwork(rule: JsonObject): ResolvedArtwork {
  return {
    backgroundAsset: clean(rule.image),
    aodAsset: clean(rule.aodStaticImage),
  }
}

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => containsIgnoreCase(value, keyword))
}

function containsIgnoreCase(value: string, token: string): boolean {
  return clean(value).toLowerCase().includes(clean(token).toLowerCase())
}

function stickerScale(source: unknown): number {
  const value = typeof source === "number" ? source : 1
  if (!Number.isFinite(value)) return 1
  return Math.max(0.25, Math.min(2, value))
}

function assetBasename(source: string): string {
  const parts = clean(source).split(/[\\/]/)
  return parts.at(-1) ?? ""
}

function androidColor(source: unknown, fallback: number): number {
  let value = clean(source)
  if (value.startsWith("#")) value = value.slice(1)
  if (!/^[0-9a-f]+$/i.test(value)) return fallback
  if (value.length === 6) return 0xff000000 + Number.parseInt(value, 16)
  if (value.length === 8) return Number.parseInt(value, 16)
  return fallback
}

function alphaBlend(foreground: number, background: number): number {
  const alpha = channel(foreground, 24)
  if (alpha === 0) return background
  const inverse = 255 - alpha
  const red = Math.round((alpha * channel(foreground, 16)
    + inverse * channel(background, 16)) / 255)
  const green = Math.round((alpha * channel(foreground, 8)
    + inverse * channel(background, 8)) / 255)
  const blue = Math.round((alpha * channel(foreground, 0)
    + inverse * channel(background, 0)) / 255)
  return 0xff000000 + red * 0x10000 + green * 0x100 + blue
}

function computeLuminance(color: number): number {
  const red = linearize(channel(color, 16) / 255)
  const green = linearize(channel(color, 8) / 255)
  const blue = linearize(channel(color, 0) / 255)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function linearize(component: number): number {
  return component <= 0.03928
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4
}

function rgbHex(color: number): string {
  return (`#${channel(color, 16).toString(16).padStart(2, "0")}`
    + channel(color, 8).toString(16).padStart(2, "0")
    + channel(color, 0).toString(16).padStart(2, "0"))
    .toUpperCase()
}

function channel(color: number, shift: number): number {
  return Math.floor(color / (2 ** shift)) & 0xff
}

function strings(source: unknown): string[] {
  if (!Array.isArray(source)) return []
  const result: string[] = []
  for (const entry of source) {
    const value = clean(entry)
    if (value && !result.includes(value)) result.push(value)
  }
  return result
}

function clean(source: unknown): string {
  return typeof source === "string" ? source.trim() : ""
}

function optionalObject(source: unknown): JsonObject {
  return optionalObjectOrNull(source) ?? {}
}

function optionalObjectOrNull(source: unknown): JsonObject | null {
  return source !== null && typeof source === "object" && !Array.isArray(source)
    ? source as JsonObject
    : null
}

function objectAt(source: unknown, label: string): JsonObject {
  const result = optionalObjectOrNull(source)
  if (!result) throw new Error(`Expected object at ${label}`)
  return result
}

function objectField(source: JsonObject, name: string): JsonObject {
  return objectAt(source[name], name)
}

function arrayAt(source: JsonObject, name: string): unknown[] {
  if (!Array.isArray(source[name])) throw new Error(`Expected array at ${name}`)
  return source[name]
}

function optionalArray(source: unknown): unknown[] {
  return Array.isArray(source) ? source : []
}
