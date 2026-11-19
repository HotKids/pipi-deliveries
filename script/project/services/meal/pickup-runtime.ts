type JsonObject = Record<string, unknown>

export class PickupPattern {
  readonly source: string
  readonly label: string
  private readonly single: RegExp
  private readonly global: RegExp

  constructor(source: string, label: string) {
    this.source = source.trim()
    this.label = label
    try {
      this.single = new RegExp(this.source, "i")
      this.global = new RegExp(this.source, "gi")
    } catch (error) {
      throw new Error(`Invalid pickup runtime regex at ${label}: ${String(error)}`)
    }
  }

  finds(value: string): boolean {
    return this.single.test(value)
  }

  firstMatch(value: string): RegExpExecArray | null {
    return this.single.exec(value)
  }

  matches(value: string): boolean {
    const match = this.firstMatch(value)
    return match !== null && match.index === 0 && match[0].length === value.length
  }

  replaceFirst(value: string, replacement: string): string {
    return value.replace(this.single, replacement)
  }

  replaceAll(value: string, replacement: string): string {
    this.global.lastIndex = 0
    return value.replace(this.global, replacement)
  }

  extractAll(value: string, groupIndex = 0): string[] {
    const matches: string[] = []
    this.global.lastIndex = 0
    const regex = this.global
    for (const match of value.matchAll(regex)) {
      const extracted = (match[groupIndex] ?? match[0] ?? "").trim()
      if (extracted) matches.push(extracted)
    }
    return matches
  }
}

export interface PickupFieldRule {
  readonly regex: PickupPattern
  readonly groupIndex: number
}

export interface PickupBrandRule {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly keywords: readonly string[]
  readonly hostPackages: readonly string[]
  readonly classPatterns: readonly PickupPattern[]
  readonly miniLabels: readonly string[]
  readonly qrPattern?: PickupPattern
  readonly requireQrCode: boolean
  readonly redemption?: { pageStatus: string; username?: PickupPattern }
}

export interface PickupCodeBrandRule {
  readonly brandId: string
  readonly brandName: string
  readonly code: PickupPattern
  readonly requiredCategory: string
  readonly requiredProduct?: PickupPattern
  readonly requiredText?: PickupPattern
  readonly forbiddenText?: PickupPattern
}

export interface PickupAppRule {
  readonly brandId: string
  readonly packageName: string
  readonly classPattern?: PickupPattern
  readonly pagePatterns: readonly PickupPattern[]
}

export interface PickupLocalPolicy {
  readonly code: {
    readonly labelPrefix: PickupPattern
    readonly edgePunctuation: PickupPattern
    readonly dateOrTime: PickupPattern
    readonly allowed: PickupPattern
    readonly noise: PickupPattern
    readonly mergedChineseSlash: PickupPattern
    readonly minLength: number
    readonly maxLength: number
  }
  readonly merchant: {
    readonly edgePrefix: PickupPattern
    readonly ocrLetterPrefix: PickupPattern
    readonly edgeSuffix: PickupPattern
    readonly embeddedStore: PickupPattern
    readonly storeSuffix: PickupPattern
    readonly noise: PickupPattern
    readonly minLength: number
    readonly maxLength: number
  }
  readonly product: {
    readonly quantitySuffix: PickupPattern
    readonly quantityOnly: PickupPattern
    readonly itemQuantity: PickupPattern
    readonly noise: PickupPattern
    readonly storePromotion: PickupPattern
    readonly address: PickupPattern
    readonly multiOption: PickupPattern
    readonly foodKeyword: PickupPattern
    readonly artPrefix: PickupPattern
    readonly price: PickupPattern
    readonly priceColumnStart: PickupPattern
    readonly storeName: PickupPattern
    readonly minLength: number
    readonly maxLength: number
  }
}

export interface PickupRuntime {
  readonly schemaVersion: number
  readonly ttlSeconds: number
  readonly genericBrandId: string
  readonly genericBrandName: string
  readonly brands: readonly PickupBrandRule[]
  readonly brandsById: ReadonlyMap<string, PickupBrandRule>
  readonly appRules: readonly PickupAppRule[]
  readonly miniProgramPackages: readonly string[]
  readonly miniLabelToBrand: ReadonlyMap<string, string>
  readonly brandNameToBrand: ReadonlyMap<string, string>
  readonly trademarkWords: ReadonlyMap<string, string>
  readonly loyaltyWords: ReadonlyMap<string, string>
  readonly productCueWords: ReadonlyMap<string, string>
  readonly falsePositiveGuards: readonly string[]
  readonly codeBrandRules: readonly PickupCodeBrandRule[]
  readonly categoryKeywords: ReadonlyMap<string, readonly string[]>
  readonly completionStatus: PickupPattern
  readonly cancellationStatus: PickupPattern
  readonly progressStatusWords: readonly string[]
  readonly terminalStatusWords: readonly string[]
  readonly scoring: {
    readonly weights: ReadonlyMap<string, number>
    readonly labelPrefix: PickupPattern
    readonly codeValueShape: PickupPattern
    readonly rejects: readonly {
      readonly regex: PickupPattern
      readonly weightKey: string
    }[]
  }
  readonly base: {
    readonly pickupCode: readonly PickupFieldRule[]
    readonly merchantName: readonly PickupFieldRule[]
    readonly productName: readonly PickupFieldRule[]
    readonly waitTime: readonly PickupFieldRule[]
    readonly specLine: PickupPattern
    readonly specSkipPrev: PickupPattern
    readonly productTail: PickupPattern
  }
  readonly postV2: {
    readonly pickupCode: readonly PickupFieldRule[]
    readonly merchantName: readonly PickupFieldRule[]
    readonly productName: readonly PickupFieldRule[]
    readonly waitTime: readonly PickupFieldRule[]
    readonly blacklistNear: readonly string[]
    readonly conditionalLabelWords: readonly string[]
    readonly conditionalLabelShape: PickupPattern
    readonly codeLabelOnly: PickupPattern
    readonly codeLabelSkipNext: PickupPattern
    readonly codeFreeformLabel: PickupPattern
    readonly codeLabelLookahead: number
    readonly specLine: PickupPattern
    readonly specSkipPrev: PickupPattern
    readonly productTail: PickupPattern
    readonly stepWords: readonly string[]
    readonly stepMinHits: number
  }
  readonly local: PickupLocalPolicy
}

export function createPickupRuntime(source: unknown): PickupRuntime {
  const root = objectAt(source, "pickup runtime")
  const schemaVersion = integerAt(root, "schemaVersion")
  if (schemaVersion < 3) throw new Error("Pickup runtime schemaVersion 3 or newer is required")

  const lifecycle = objectField(root, "cardLifecycle")
  const ttlSeconds = positiveIntegerAt(lifecycle, "ttlSeconds")
  if (ttlSeconds % 60 !== 0) throw new Error("Pickup runtime ttlSeconds must be whole minutes")
  const behavior = objectField(root, "behavior")
  const lifetimeMinutes = integerAt(behavior, "cardLifetimeMinutes")
  if (lifetimeMinutes * 60 !== ttlSeconds) {
    throw new Error("Pickup runtime behavior lifetime must match cardLifecycle")
  }

  const unknownBrand = objectField(root, "unknownBrandDefaults")
  const genericBrandId = stringAt(unknownBrand, "genericId")
  const genericBrandName = stringAt(unknownBrand, "genericName")

  const brands = arrayAt(root, "brands").map((entry, index) => {
    const brand = objectAt(entry, `brands[${index}]`)
    const redemption = brand.redemption ? objectAt(brand.redemption, "redemption") : null
    return {
      id: stringAt(brand, "id"),
      name: stringAt(brand, "name"),
      category: stringAt(brand, "category"),
      keywords: stringsAt(brand, "keywords"),
      hostPackages: stringsAt(brand, "hostPackages"),
      classPatterns: stringsAt(brand, "classPatterns").map((value, patternIndex) =>
        pattern(value, `brands[${index}].classPatterns[${patternIndex}]`)),
      miniLabels: stringsAt(brand, "miniLabels"),
      qrPattern: optionalPattern(brand.qrPattern, `brands[${index}].qrPattern`),
      requireQrCode: brand.requireQrCode === true,
      redemption: redemption ? {
        pageStatus: stringAt(redemption, "pageStatus"),
        username: optionalPattern(redemption.usernamePattern, "redemption.usernamePattern"),
      } : undefined,
    } satisfies PickupBrandRule
  })
  if (brands.length === 0) throw new Error("Pickup runtime must contain brands")
  const brandsById = new Map(brands.map((brand) => [brand.id, brand]))

  const appRules = arrayAt(root, "appRules").map((entry, index) => {
    const app = objectAt(entry, `appRules[${index}]`)
    const pagePatterns: PickupPattern[] = []
    addOptionalPattern(pagePatterns, app.pageTitle, `appRules[${index}].pageTitle`)
    const variants = Array.isArray(app.infoRegex) ? app.infoRegex : []
    variants.forEach((variantValue, variantIndex) => {
      const variant = objectAt(variantValue, `appRules[${index}].infoRegex[${variantIndex}]`)
      addOptionalPattern(
        pagePatterns,
        variant.pageTitle,
        `appRules[${index}].infoRegex[${variantIndex}].pageTitle`,
      )
    })
    return {
      brandId: optionalString(app.brandId),
      packageName: optionalString(app.packageName),
      classPattern: optionalPattern(app.clzName, `appRules[${index}].clzName`),
      pagePatterns,
    } satisfies PickupAppRule
  })

  const mini = objectField(root, "miniProgramRules")
  const miniProgramPackages = arrayAt(mini, "hosts").map((entry, index) =>
    stringAt(objectAt(entry, `miniProgramRules.hosts[${index}]`), "packageName"))
  const miniLabelToBrand = stringMap(
    objectField(mini, "labelToBrand"),
    brandsById,
    true,
  )

  const trademarkWords = wordMap(root.brandTrademarkWords, brandsById)
  const loyaltyWords = wordMap(root.brandLoyaltyCueWords, brandsById)
  const productCueWords = wordMap(root.brandProductCueWords, brandsById)
  const falsePositiveGuards = stringsAt(
    objectField(root, "brandFalsePositiveGuards"),
    "labels",
  )

  const codeBrandRules: PickupCodeBrandRule[] = []
  arrayAt(objectField(root, "brandFromCode"), "rules").forEach((entry, index) => {
    const rule = objectAt(entry, `brandFromCode.rules[${index}]`)
    const brandId = stringAt(rule, "brandId")
    if (!brandsById.has(brandId)) return
    const requiredPageWord = optionalString(rule.requirePageWord)
    const forbiddenPageWord = optionalString(rule.forbidPageWord)
    codeBrandRules.push({
      brandId,
      brandName: optionalString(rule.brandName),
      code: pattern(stringAt(rule, "regex"), `brandFromCode.rules[${index}].regex`),
      requiredCategory: optionalString(rule.category) || optionalString(rule.requiredCategory),
      requiredProduct: optionalPattern(
        rule.requiredProductRegex,
        `brandFromCode.rules[${index}].requiredProductRegex`,
      ),
      requiredText: requiredPageWord
        ? literalPattern(requiredPageWord, `brandFromCode.rules[${index}].requirePageWord`)
        : optionalPattern(rule.requiredTextRegex, `brandFromCode.rules[${index}].requiredTextRegex`),
      forbiddenText: forbiddenPageWord
        ? literalPattern(forbiddenPageWord, `brandFromCode.rules[${index}].forbidPageWord`)
        : undefined,
    })
  })
  const brandNameToBrand = new Map(
    codeBrandRules
      .filter((rule) => rule.brandName)
      .sort((left, right) => right.brandName.length - left.brandName.length)
      .map((rule) => [rule.brandName, rule.brandId]),
  )

  const scoringSource = objectField(root, "scoring")
  const weightsSource = objectField(scoringSource, "weights")
  const weights = new Map<string, number>()
  for (const [key, value] of Object.entries(weightsSource)) {
    if (typeof value === "number" && Number.isFinite(value)) weights.set(key, Math.trunc(value))
  }
  const rejectSources = stringsAt(scoringSource, "regex_reject")
  const rejectWeightKeys = stringsAt(scoringSource, "regexRejectWeightKeys")
  const rejects = rejectSources.map((value, index) => ({
    regex: pattern(value, `scoring.regex_reject[${index}]`),
    weightKey: rejectWeightKeys[index]
      || (value.startsWith("^1[3-9]") ? "looks_like_phone" : "looks_like_amount"),
  }))

  const baseDefaults = objectField(root, "fieldDefaults")
  const postV2Source = objectField(root, "postV2Overrides")
  const postDefaults = objectField(postV2Source, "fieldDefaults")
  const baseSpec = objectField(baseDefaults, "specLine")
  const postSpec = objectField(postDefaults, "specLine")
  const codeLabelOnly = objectField(postDefaults, "codeLabelOnly")
  const conditionalLabels = objectField(postDefaults, "conditionalLabels")
  const stepRow = objectField(postDefaults, "stepRow")

  return {
    schemaVersion,
    ttlSeconds,
    genericBrandId,
    genericBrandName,
    brands,
    brandsById,
    appRules,
    miniProgramPackages,
    miniLabelToBrand,
    brandNameToBrand,
    trademarkWords,
    loyaltyWords,
    productCueWords,
    falsePositiveGuards,
    codeBrandRules,
    categoryKeywords: categoryKeywordMap(unknownBrand),
    completionStatus: requiredPattern(behavior, "completionStatusRegex", "behavior"),
    cancellationStatus: requiredPattern(behavior, "cancellationStatusRegex", "behavior"),
    progressStatusWords: stringsAt(objectField(root, "orderStatusWords"), "progress"),
    terminalStatusWords: stringsAt(objectField(root, "orderStatusWords"), "terminal"),
    scoring: {
      weights,
      labelPrefix: requiredPattern(scoringSource, "labelPrefixRegex", "scoring"),
      codeValueShape: requiredPattern(scoringSource, "codeValueShape", "scoring"),
      rejects,
    },
    base: {
      pickupCode: fieldRules(baseDefaults, "pickupCode", "fieldDefaults"),
      merchantName: fieldRules(baseDefaults, "merchantName", "fieldDefaults"),
      productName: fieldRules(baseDefaults, "productName", "fieldDefaults"),
      waitTime: fieldRules(baseDefaults, "waitTime", "fieldDefaults"),
      specLine: requiredPattern(baseSpec, "regex", "fieldDefaults.specLine"),
      specSkipPrev: requiredPattern(baseSpec, "skipPrev", "fieldDefaults.specLine"),
      productTail: requiredPattern(baseDefaults, "productTailRe", "fieldDefaults"),
    },
    postV2: {
      pickupCode: fieldRules(postDefaults, "pickupCode", "postV2Overrides.fieldDefaults"),
      merchantName: fieldRules(postDefaults, "merchantName", "postV2Overrides.fieldDefaults"),
      productName: fieldRules(postDefaults, "productName", "postV2Overrides.fieldDefaults"),
      waitTime: fieldRules(postDefaults, "waitTime", "postV2Overrides.fieldDefaults"),
      blacklistNear: stringsAt(postDefaults, "blacklistNear"),
      conditionalLabelWords: stringsAt(conditionalLabels, "words"),
      conditionalLabelShape: requiredPattern(
        conditionalLabels,
        "asLabelWhen",
        "postV2Overrides.fieldDefaults.conditionalLabels",
      ),
      codeLabelOnly: requiredPattern(
        codeLabelOnly,
        "regex",
        "postV2Overrides.fieldDefaults.codeLabelOnly",
      ),
      codeLabelSkipNext: requiredPattern(
        codeLabelOnly,
        "skipNext",
        "postV2Overrides.fieldDefaults.codeLabelOnly",
      ),
      codeFreeformLabel: requiredPattern(
        codeLabelOnly,
        "freeformRegex",
        "postV2Overrides.fieldDefaults.codeLabelOnly",
      ),
      codeLabelLookahead: positiveIntegerAt(codeLabelOnly, "lookahead"),
      specLine: requiredPattern(postSpec, "regex", "postV2Overrides.fieldDefaults.specLine"),
      specSkipPrev: requiredPattern(
        postSpec,
        "skipPrev",
        "postV2Overrides.fieldDefaults.specLine",
      ),
      productTail: requiredPattern(
        postDefaults,
        "productTailRe",
        "postV2Overrides.fieldDefaults",
      ),
      stepWords: stringsAt(stepRow, "words"),
      stepMinHits: positiveIntegerAt(stepRow, "minHits"),
    },
    local: localPolicy(objectField(postV2Source, "localHeuristics")),
  }
}

function localPolicy(source: JsonObject): PickupLocalPolicy {
  const code = objectField(source, "code")
  const merchant = objectField(source, "merchant")
  const productSource = objectField(source, "product")
  return {
    code: {
      labelPrefix: requiredPattern(code, "labelPrefixRegex", "localHeuristics.code"),
      edgePunctuation: requiredPattern(code, "edgePunctuationRegex", "localHeuristics.code"),
      dateOrTime: requiredPattern(code, "dateOrTimeRegex", "localHeuristics.code"),
      allowed: requiredPattern(code, "allowedRegex", "localHeuristics.code"),
      noise: requiredPattern(code, "noiseRegex", "localHeuristics.code"),
      mergedChineseSlash: requiredPattern(code, "mergedChineseSlashRegex", "localHeuristics.code"),
      minLength: positiveIntegerAt(code, "minLength"),
      maxLength: positiveIntegerAt(code, "maxLength"),
    },
    merchant: {
      edgePrefix: requiredPattern(merchant, "edgePrefixRegex", "localHeuristics.merchant"),
      ocrLetterPrefix: requiredPattern(merchant, "ocrLetterPrefixRegex", "localHeuristics.merchant"),
      edgeSuffix: requiredPattern(merchant, "edgeSuffixRegex", "localHeuristics.merchant"),
      embeddedStore: requiredPattern(merchant, "embeddedStoreRegex", "localHeuristics.merchant"),
      storeSuffix: requiredPattern(merchant, "storeSuffixRegex", "localHeuristics.merchant"),
      noise: requiredPattern(merchant, "noiseRegex", "localHeuristics.merchant"),
      minLength: positiveIntegerAt(merchant, "minLength"),
      maxLength: positiveIntegerAt(merchant, "maxLength"),
    },
    product: {
      quantitySuffix: requiredPattern(productSource, "quantitySuffixRegex", "localHeuristics.product"),
      quantityOnly: requiredPattern(productSource, "quantityOnlyRegex", "localHeuristics.product"),
      itemQuantity: requiredPattern(productSource, "itemQuantityRegex", "localHeuristics.product"),
      noise: requiredPattern(productSource, "noiseRegex", "localHeuristics.product"),
      storePromotion: requiredPattern(productSource, "storePromotionRegex", "localHeuristics.product"),
      address: requiredPattern(productSource, "addressRegex", "localHeuristics.product"),
      multiOption: requiredPattern(productSource, "multiOptionRegex", "localHeuristics.product"),
      foodKeyword: requiredPattern(productSource, "foodKeywordRegex", "localHeuristics.product"),
      artPrefix: requiredPattern(productSource, "artPrefixRegex", "localHeuristics.product"),
      price: requiredPattern(productSource, "priceRegex", "localHeuristics.product"),
      priceColumnStart: requiredPattern(
        productSource,
        "priceColumnStartRegex",
        "localHeuristics.product",
      ),
      storeName: requiredPattern(productSource, "storeNameRegex", "localHeuristics.product"),
      minLength: positiveIntegerAt(productSource, "minLength"),
      maxLength: positiveIntegerAt(productSource, "maxLength"),
    },
  }
}

function fieldRules(source: JsonObject, key: string, path: string): PickupFieldRule[] {
  return arrayAt(source, key).map((entry, index) => {
    const rule = objectAt(entry, `${path}.${key}[${index}]`)
    const groupIndex = typeof rule.groupIndex === "number" ? Math.max(0, Math.trunc(rule.groupIndex)) : 0
    return {
      regex: requiredPattern(rule, "regex", `${path}.${key}[${index}]`),
      groupIndex,
    }
  })
}

function categoryKeywordMap(unknownBrand: JsonObject): ReadonlyMap<string, readonly string[]> {
  const source = objectField(unknownBrand, "categoryKeywords")
  return new Map([
    ["coffee", stringsAt(source, "coffee")],
    ["tea", stringsAt(source, "tea")],
    ["catering", stringsAt(source, "catering")],
  ])
}

function wordMap(source: unknown, brands: ReadonlyMap<string, PickupBrandRule>): ReadonlyMap<string, string> {
  const section = objectAt(source, "brand word section")
  return stringMap(objectField(section, "words"), brands, false)
}

function stringMap(
  source: JsonObject,
  brands: ReadonlyMap<string, PickupBrandRule>,
  sortByLength: boolean,
): ReadonlyMap<string, string> {
  const entries = Object.entries(source)
    .filter(([key, value]) => key.trim() && typeof value === "string" && brands.has(value.trim()))
    .map(([key, value]) => [key.trim(), (value as string).trim()] as const)
  if (sortByLength) entries.sort((left, right) => right[0].length - left[0].length)
  return new Map(entries)
}

function requiredPattern(source: JsonObject, key: string, path: string): PickupPattern {
  const value = stringAt(source, key)
  return pattern(value, `${path}.${key}`)
}

function optionalPattern(source: unknown, label: string): PickupPattern | undefined {
  const value = optionalString(source)
  return value ? pattern(value, label) : undefined
}

function addOptionalPattern(output: PickupPattern[], source: unknown, label: string): void {
  const compiled = optionalPattern(source, label)
  if (compiled) output.push(compiled)
}

function pattern(source: string, label: string): PickupPattern {
  if (!source.trim()) throw new Error(`Missing pickup runtime regex at ${label}`)
  return new PickupPattern(source, label)
}

function literalPattern(source: string, label: string): PickupPattern {
  return new PickupPattern(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), label)
}

function objectAt(source: unknown, label: string): JsonObject {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`Missing pickup runtime object at ${label}`)
  }
  return source as JsonObject
}

function objectField(source: JsonObject, key: string): JsonObject {
  return objectAt(source[key], key)
}

function arrayAt(source: JsonObject, key: string): unknown[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value
}

function stringsAt(source: JsonObject, key: string): string[] {
  return arrayAt(source, key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
}

function stringAt(source: JsonObject, key: string): string {
  const value = optionalString(source[key])
  if (!value) throw new Error(`Missing pickup runtime string at ${key}`)
  return value
}

function optionalString(source: unknown): string {
  return typeof source === "string" ? source.trim() : ""
}

function integerAt(source: JsonObject, key: string): number {
  const value = source[key]
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Missing pickup runtime integer at ${key}`)
  }
  return value
}

function positiveIntegerAt(source: JsonObject, key: string): number {
  const value = integerAt(source, key)
  if (value <= 0) throw new Error(`Invalid pickup runtime integer at ${key}`)
  return value
}
