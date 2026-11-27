import type {
  PickupCredential,
  PickupOcrBlock,
  PickupParseInput,
  PickupRecognitionHost,
} from "./pickup-types.ts"
import type {
  PickupBrandRule,
  PickupCodeBrandRule,
  PickupFieldRule,
  PickupPattern,
  PickupRuntime,
} from "./pickup-runtime.ts"

interface CodeCandidate {
  code: string
  valueIndex: number
  scoreIndex: number
  directCredentialLabel: boolean
  explicitRule: boolean
  blacklistExempt: string
  sequence: number
  score: number
}

interface MerchantChoice {
  value: string
  index: number
  score: number
}

interface FoundProduct {
  order: number
  left: number
  name: string
  strong: boolean
}

const CONDITIONAL_INLINE_VALUE = /^[：:\s]*([A-Za-z0-9\-]{2,12})/iu
const CONDITIONAL_LABEL_OFFSETS = [1, 2, -1] as const
const ASCII_CREDENTIAL = /^[A-Za-z0-9._-]+$/u
const CANONICAL_NUMERIC_CODE = /^[A-Za-z]{0,2}\d{2,6}$/iu
const CANONICAL_SEGMENTED_CODE = /^\d{1,3}(?:-\d{1,4}){1,3}$/u

// These structural expressions are the M v4.3 geometry contract, not recognition vocabulary.
const PURE_PRICE = /^[¥￥0-9\s.,xX×份杯件个套盒-]+$/iu
const SUB_ITEM_ROW = /^\d+\s*[xX×]/iu
const LABELED_PRICE = /^[¥￥]\d+(?:\.\d{1,2})?(?:券后价|原价|现价|到手价|起)$/iu
const NEGATIVE_PRICE = /^[-−－]/u
const SECTION_BOUNDARY = /^(?:支付方式|商品小计|商品总价|商品总额|用餐信息|用餐方式|就餐方式|就餐信息|实付|优惠明细|优惠合计|优惠卡券|总优惠|(?:产品)?小计)/u
const SPEC_SEPARATORS = ["/", "、", "，", ",", " + "] as const

export function parsePickupCredential(
  input: PickupParseInput,
  runtime: PickupRuntime,
): PickupCredential | undefined {
  return parsePickupCredentials(input, runtime)[0]
}

export function parsePickupCredentials(
  input: PickupParseInput,
  runtime: PickupRuntime,
): PickupCredential[] {
  validateInput(input)
  let blocks = input.blocks
    .map((block) => ({ ...block, text: normalizePickupText(block.text) }))
    .sort((left, right) => left.top - right.top || left.left - right.left)
  if (blocks.length === 0) return []

  const rawText = blocks.map((block) => block.text).join("\n")
  const decoded = (input.rawBarcodes ?? []).filter(value => Boolean(value.trim()))
  const barcodes = decoded.map(value => value.trim())
  const identity = redemptionIdentity(runtime, rawText)
  const redemption = redemptionPage(runtime, rawText)
  if (identity) {
    blocks = blocks.filter(row => !identity.redemption?.username?.matches(row.text))
    if (blocks.length === 0) return []
  }
  const text = blocks.map((block) => block.text).join("\n")
  const hostBrand = positiveHostBrand(runtime, input.host)
  let brand = redemption
    ?? (identity ? (hostBrand ?? identity) : identifyBrand(runtime, input.host, text, barcodes))
  if (redemption) {
    if (blocks.some(row => !isStepRow(runtime, row.text) && runtime.cancellationStatus.finds(row.text))) return []
    if (new Set(decoded).size !== 1) return []
  } else if (!acceptPage(runtime, text, brand, hostBrand, barcodes)) return []
  if (!brand && mayUseBrandHint(hostBrand, barcodes)) brand = hostBrand

  const selected = redemption ? [] : selectCodes(rankCodes(blocks, input.screenWidth, runtime))
  if (!redemption && selected.length === 0) return []

  const baselineMerchant = firstExtract(blocks, runtime.base.merchantName)
  const merchantChoice = bestMerchant(baselineMerchant, blocks, runtime)
  const merchantName = merchantChoice?.value ?? ""
  const claimed = claimedRows(selected, merchantChoice?.index ?? -1)
  const baselineProduct = baselineProductName(blocks, runtime)
  const productName = chooseProduct(
    baselineProduct,
    blocks,
    selected,
    claimed,
    merchantChoice?.index ?? -1,
    runtime,
  )
  const expiresAtMs = input.recognizedAtMs + runtime.ttlSeconds * 1_000

  const waitTime = firstExtract(blocks, runtime.base.waitTime) || firstExtract(blocks, runtime.postV2.waitTime)
  if (redemption) return [{
    brandId: redemption.id, brandName: redemption.name, code: "", productName, merchantName,
    recognizedAtMs: input.recognizedAtMs, expiresAtMs, waitTime, status: "待核销", qrPayload: decoded[0],
  }]
  const status = activeStatus(blocks, runtime)

  return selected.map((candidate) => {
    const code = repairSelectedCode(candidate.code)
    let candidateBrand = brand
    const strongOverride = inferBrandFromCode(
      code,
      productName,
      text,
      runtime,
      true,
    )
    if (strongOverride) candidateBrand = strongOverride
    else if (!candidateBrand) {
      candidateBrand = inferBrandFromCode(code, productName, text, runtime, false)
    }
    return {
      brandId: candidateBrand?.id ?? runtime.genericBrandId,
      brandName: candidateBrand?.name ?? runtime.genericBrandName,
      code,
      productName,
      merchantName,
      recognizedAtMs: input.recognizedAtMs,
      expiresAtMs, waitTime, status,
      qrPayload: barcodes.find(barcode => candidateBrand?.qrPattern?.matches(barcode)) ?? "",
    }
  })
}

export function redemptionIdentity(runtime: PickupRuntime, text: string): PickupBrandRule | undefined {
  const lines = text.split(/\r?\n/u)
  return runtime.brands.find(brand => brand.redemption &&
    (brand.keywords.some(keyword => text.includes(keyword)) ||
      lines.some(line => brand.redemption?.username?.matches(line.trim()))))
}

export function redemptionPage(runtime: PickupRuntime, text: string): PickupBrandRule | undefined {
  const brand = redemptionIdentity(runtime, text)
  return brand?.redemption && text.includes(brand.redemption.pageStatus) ? brand : undefined
}

function activeStatus(blocks: readonly PickupOcrBlock[], runtime: PickupRuntime): string {
  const words = [...runtime.progressStatusWords, ...runtime.postV2.stepWords].filter(word =>
    word && !runtime.completionStatus.finds(word) && !runtime.terminalStatusWords.some(terminal => word.includes(terminal)))
  return blocks.filter(row => !isStepRow(runtime, row.text))
    .map(row => words.find(word => row.text.includes(word))).find(Boolean) ?? ""
}

export function parseLuckinDraft(input: PickupParseInput, runtime: PickupRuntime): PickupCredential | undefined {
  const blocks = input.blocks.map(row => ({ ...row, text: normalizePickupText(row.text) }))
    .sort((a, b) => a.top - b.top || a.left - b.left)
  if (blocks.some(row => !isStepRow(runtime, row.text) && runtime.cancellationStatus.finds(row.text))) return undefined
  const text = blocks.map(row => row.text).join("\n")
  const brand = identifyBrand(runtime, input.host, text, [])
  const status = activeStatus(blocks, runtime)
  if (brand?.id !== "ruixing" || !hasPageEvidence(runtime, text, brand) || !status) return undefined
  let merchant = bestMerchant(firstExtract(blocks, runtime.base.merchantName), blocks, runtime)
  if (!merchant) {
    for (const [index, row] of blocks.entries()) {
      const marker = row.text.search(/[(（]NO\./u)
      const value = marker > 0 ? row.text.slice(0, marker).trim() : ""
      if (value.length >= 2 && value.endsWith("店")) {
        merchant = { value, index, score: 0 }
        break
      }
    }
  }
  const merchantRow = merchant?.index ?? -1
  const productName = chooseProduct(baselineProductName(blocks, runtime), blocks, [],
    claimedRows([], merchantRow), merchantRow, runtime)
  if (!productName) return undefined
  return {
    brandId: brand.id, brandName: brand.name, code: "", merchantName: merchant?.value ?? "", productName, status,
    waitTime: firstExtract(blocks, runtime.base.waitTime) || firstExtract(blocks, runtime.postV2.waitTime),
    recognizedAtMs: input.recognizedAtMs, expiresAtMs: input.recognizedAtMs + runtime.ttlSeconds * 1000, qrPayload: "",
  }
}

export function onlineBrand(runtime: PickupRuntime, name: string, code: string, product: string, spec: string) {
  const expected = name.trim()
  if (expected) return runtime.brands.find(brand => containsIgnoreCase(brand.name, expected) ||
    [brand.id, ...brand.keywords, ...brand.miniLabels].some(value => value.toLowerCase() === expected.toLowerCase()))
  const category = categoryFromText(runtime, product + "\n" + spec)
  const peets = runtime.codeBrandRules.find(rule => rule.brandId === "peetscoffee" &&
    codeBrandRuleMatches(rule, code.toUpperCase(), product, spec, category))
  return peets ? runtime.brandsById.get(peets.brandId) : undefined
}

export function normalizePickupText(value: string): string {
  let normalized = ""
  for (const original of value) {
    const code = original.codePointAt(0) ?? 0
    let character = original
    if (code >= 0xff21 && code <= 0xff3a) character = String.fromCodePoint(0x41 + code - 0xff21)
    else if (code >= 0xff41 && code <= 0xff5a) character = String.fromCodePoint(0x61 + code - 0xff41)
    else if (code >= 0xff10 && code <= 0xff19) character = String.fromCodePoint(0x30 + code - 0xff10)
    else if (code === 0x3000) character = " "
    if ("·•・‧∙⋅".includes(character)) character = "·"
    const current = character.codePointAt(0) ?? 0
    if ((current >= 0x200b && current <= 0x200f) || current === 0xfeff) continue
    normalized += character
  }
  return normalized.replace(/[ \t]+/gu, " ").trim()
}

export function clusterPickupRows(blocks: readonly PickupOcrBlock[]): number[][] {
  const order = blocks
    .map((_, index) => index)
    .sort((left, right) => blocks[left].top - blocks[right].top || blocks[left].left - blocks[right].left)
  const rows: number[][] = []
  let anchorTop = 0
  let anchorBottom = -1
  let current: number[] | undefined
  for (const index of order) {
    const block = blocks[index]
    const center = Math.trunc((block.top + block.bottom) / 2)
    if (current && center >= anchorTop && center < anchorBottom) {
      current.push(index)
    } else {
      current = [index]
      rows.push(current)
      anchorTop = block.top
      anchorBottom = block.bottom
    }
  }
  return rows
}

function validateInput(input: PickupParseInput): void {
  if (!Number.isFinite(input.screenWidth) || input.screenWidth <= 0) {
    throw new TypeError("Pickup parser requires a positive screenWidth")
  }
  if (!Number.isSafeInteger(input.recognizedAtMs) || input.recognizedAtMs < 0) {
    throw new TypeError("Pickup parser requires a non-negative recognizedAtMs")
  }
  input.blocks.forEach((block, index) => {
    if (typeof block.text !== "string") throw new TypeError(`Pickup block ${index} has no text`)
    for (const coordinate of [block.left, block.top, block.right, block.bottom]) {
      if (!Number.isFinite(coordinate)) {
        throw new TypeError(`Pickup block ${index} has a non-finite bounding box`)
      }
    }
    if (block.right < block.left || block.bottom < block.top) {
      throw new TypeError(`Pickup block ${index} has an inverted bounding box`)
    }
  })
}

function identifyBrand(
  runtime: PickupRuntime,
  host: PickupRecognitionHost | undefined,
  text: string,
  barcodes: readonly string[],
): PickupBrandRule | undefined {
  const hostMatch = positiveHostBrand(runtime, host)
  if (hostMatch) return hostMatch
  for (const barcode of barcodes) {
    const match = runtime.brands.find((brand) => brand.qrPattern?.matches(barcode))
    if (match) return match
  }
  return contentBrand(runtime, text)
}

function positiveHostBrand(
  runtime: PickupRuntime,
  host: PickupRecognitionHost | undefined,
): PickupBrandRule | undefined {
  if (!host) return undefined
  const packageName = host.packageName?.trim() ?? ""
  const labels = `${host.miniProgramLabel ?? ""}\n${host.pageLabel ?? ""}`.trim()
  if (runtime.miniProgramPackages.includes(packageName)) {
    for (const [label, brandId] of runtime.miniLabelToBrand) {
      if (containsIgnoreCase(labels, label)) return runtime.brandsById.get(brandId)
    }
    for (const brand of runtime.brands) {
      if (brand.miniLabels.some((label) => containsIgnoreCase(labels, label))) return brand
    }
    return undefined
  }
  if (!packageName) return undefined
  for (const brand of runtime.brands) {
    if (!brand.hostPackages.includes(packageName)) continue
    if (brand.classPatterns.length === 0) return brand
    const className = host.className?.trim() ?? ""
    if (className && brand.classPatterns.some((candidate) => candidate.matches(className))) {
      return brand
    }
  }
  return undefined
}

function contentBrand(runtime: PickupRuntime, text: string): PickupBrandRule | undefined {
  let match = brandFromWords(runtime, text, runtime.trademarkWords)
  if (match) return match
  match = brandFromWords(runtime, text, runtime.loyaltyWords)
  if (match) return match

  let masked = text
  for (const guard of runtime.falsePositiveGuards) masked = masked.split(guard).join("")
  for (const [label, brandId] of runtime.miniLabelToBrand) {
    if (containsIgnoreCase(masked, label)) {
      match = runtime.brandsById.get(brandId)
      if (match) return match
    }
  }
  for (const [name, brandId] of runtime.brandNameToBrand) {
    if (containsIgnoreCase(masked, name)) {
      match = runtime.brandsById.get(brandId)
      if (match) return match
    }
  }
  return brandFromWords(runtime, text, runtime.productCueWords)
}

function brandFromWords(
  runtime: PickupRuntime,
  text: string,
  words: ReadonlyMap<string, string>,
): PickupBrandRule | undefined {
  for (const [word, brandId] of words) {
    if (containsIgnoreCase(text, word)) return runtime.brandsById.get(brandId)
  }
  return undefined
}

function acceptPage(
  runtime: PickupRuntime,
  text: string,
  brand: PickupBrandRule | undefined,
  hostBrand: PickupBrandRule | undefined,
  barcodes: readonly string[],
): boolean {
  if (brand?.requireQrCode && !barcodeMatches(brand, barcodes)) return false
  for (const line of text.split(/\r?\n/u)) {
    if (!line || isStepRow(runtime, line)) continue
    if (runtime.cancellationStatus.finds(line)) return false
  }
  if (hasPageEvidence(runtime, text, brand)) return true
  return mayUseBrandHint(hostBrand, barcodes) && hasPageEvidence(runtime, text, hostBrand)
}

function hasPageEvidence(
  runtime: PickupRuntime,
  text: string,
  visibleBrand: PickupBrandRule | undefined,
): boolean {
  if (runtime.appRules.some((app) => app.pagePatterns.some((candidate) => candidate.finds(text)))) {
    return true
  }
  if (runtime.scoring.labelPrefix.finds(text) || runtime.postV2.codeLabelOnly.matches(text)) {
    return true
  }
  return hasConfiguredCodeBrandEvidence(runtime, text, visibleBrand)
}

function hasConfiguredCodeBrandEvidence(
  runtime: PickupRuntime,
  text: string,
  visibleBrand: PickupBrandRule | undefined,
): boolean {
  const category = visibleBrand?.category ?? categoryFromText(runtime, text)
  for (const token of text.split(/\s+/u)) {
    for (const field of runtime.base.pickupCode) {
      for (const extracted of field.regex.extractAll(token, field.groupIndex)) {
        const code = cleanCode(extracted, runtime).toUpperCase()
        if (runtime.codeBrandRules.some((rule) => codeBrandRuleMatches(rule, code, "", text, category))) {
          return true
        }
      }
    }
  }
  return false
}

function mayUseBrandHint(
  brand: PickupBrandRule | undefined,
  barcodes: readonly string[],
): brand is PickupBrandRule {
  return Boolean(brand && (!brand.requireQrCode || barcodeMatches(brand, barcodes)))
}

function barcodeMatches(brand: PickupBrandRule, barcodes: readonly string[]): boolean {
  return Boolean(brand.qrPattern && barcodes.some((value) => brand.qrPattern?.matches(value)))
}

function rankCodes(
  blocks: readonly PickupOcrBlock[],
  screenWidth: number,
  runtime: PickupRuntime,
): CodeCandidate[] {
  const candidates: CodeCandidate[] = []
  const tallest = tallestIndex(blocks)
  for (let index = 0; index < blocks.length; index += 1) {
    const line = blocks[index].text
    const direct = runtime.scoring.labelPrefix.finds(line)
    addConfiguredCodes(candidates, line, index, index, direct, true, "", blocks, screenWidth, tallest, runtime)
    for (const column of line.split(/\s{1,}/u)) {
      if (column !== line) {
        addConfiguredCodes(candidates, column, index, index, direct, true, "", blocks, screenWidth, tallest, runtime)
      }
    }
    addConditionalLabelCodes(candidates, line, index, blocks, screenWidth, tallest, runtime)

    if (!runtime.postV2.codeLabelOnly.matches(line)) continue
    const freeform = runtime.postV2.codeFreeformLabel.matches(line)
    if (direct) {
      const labelBlock = blocks[index]
      const labelHeight = Math.max(1, labelBlock.bottom - labelBlock.top)
      let aboveIndex = -1
      let bestAboveGap = Number.POSITIVE_INFINITY
      for (let prev = index - 1; prev >= 0; prev -= 1) {
        const valueBlock = blocks[prev]
        if (Math.min(valueBlock.right, labelBlock.right) <= Math.max(valueBlock.left, labelBlock.left)) continue
        const gap = labelBlock.top - valueBlock.bottom
        if (gap < 0) continue
        if (gap < bestAboveGap) {
          bestAboveGap = gap
          aboveIndex = prev
        }
      }
      if (aboveIndex >= 0) {
        const valueBlock = blocks[aboveIndex]
        const valueHeight = Math.max(1, valueBlock.bottom - valueBlock.top)
        if (bestAboveGap <= 2 * Math.max(valueHeight, labelHeight)) {
          const rawAbove = valueBlock.text
          if (!runtime.postV2.codeLabelSkipNext.finds(rawAbove)
              && !runtime.postV2.codeLabelOnly.matches(rawAbove)) {
            const aboveCode = cleanCode(rawAbove, runtime)
            if (isValidCodeShape(aboveCode, runtime) && (freeform || ASCII_CREDENTIAL.test(aboveCode))) {
              addCandidate(
                candidates,
                aboveCode,
                aboveIndex,
                freeform ? index : aboveIndex,
                true,
                false,
                "",
                blocks,
                screenWidth,
                tallest,
                runtime,
              )
            }
          }
        }
      }
    }
    for (let offset = 1; offset <= runtime.postV2.codeLabelLookahead; offset += 1) {
      const valueIndex = index + offset
      if (valueIndex >= blocks.length) break
      const raw = blocks[valueIndex].text
      if (runtime.postV2.codeLabelSkipNext.finds(raw)
          || runtime.postV2.codeLabelOnly.matches(raw)) continue
      const code = cleanCode(raw, runtime)
      if (isValidCodeShape(code, runtime) && (freeform || ASCII_CREDENTIAL.test(code))) {
        addCandidate(
          candidates,
          code,
          valueIndex,
          index,
          direct,
          false,
          "",
          blocks,
          screenWidth,
          tallest,
          runtime,
        )
      }
      for (const column of raw.split(/\s+/u)) {
        if (column !== raw) {
          addConfiguredCodes(
            candidates,
            column,
            valueIndex,
            index,
            direct,
            false,
            "",
            blocks,
            screenWidth,
            tallest,
            runtime,
          )
        }
      }
      break
    }
  }

  const suppressed = new Set<string>()
  for (const shorter of candidates) {
    if (shorter.directCredentialLabel) continue
    const shortCode = shorter.code.toUpperCase()
    if (candidates.some((longer) => longer !== shorter
        && longer.valueIndex === shorter.valueIndex
        && longer.code.length > shorter.code.length
        && longer.code.toUpperCase().endsWith(shortCode))) {
      suppressed.add(`${shortCode}@${shorter.valueIndex}`)
    }
  }

  const unique = new Map<string, CodeCandidate>()
  for (const candidate of candidates) {
    const key = candidate.code.toUpperCase()
    if (suppressed.has(`${key}@${candidate.valueIndex}`)) continue
    const previous = unique.get(key)
    if (!previous || candidate.score > previous.score
        || (candidate.score === previous.score && candidate.sequence < previous.sequence)) {
      unique.set(key, candidate)
    }
  }
  return [...unique.values()].sort((left, right) =>
    right.score - left.score || right.code.localeCompare(left.code))
}

function addConfiguredCodes(
  output: CodeCandidate[],
  source: string,
  valueIndex: number,
  scoreIndex: number,
  direct: boolean,
  explicit: boolean,
  blacklistExempt: string,
  blocks: readonly PickupOcrBlock[],
  screenWidth: number,
  tallest: number,
  runtime: PickupRuntime,
): void {
  for (const field of runtime.postV2.pickupCode) {
    for (const extracted of field.regex.extractAll(source, field.groupIndex)) {
      addCandidate(
        output,
        extracted,
        valueIndex,
        scoreIndex,
        direct,
        explicit,
        blacklistExempt,
        blocks,
        screenWidth,
        tallest,
        runtime,
      )
    }
  }
}

function addConditionalLabelCodes(
  output: CodeCandidate[],
  line: string,
  labelIndex: number,
  blocks: readonly PickupOcrBlock[],
  screenWidth: number,
  tallest: number,
  runtime: PickupRuntime,
): void {
  for (const word of runtime.postV2.conditionalLabelWords) {
    const wordIndex = line.indexOf(word)
    if (wordIndex < 0) continue
    const suffix = line.slice(wordIndex + word.length)
    const inline = CONDITIONAL_INLINE_VALUE.exec(suffix)
    if (inline && runtime.postV2.conditionalLabelShape.matches(cleanCode(inline[1], runtime))) {
      addCandidate(
        output,
        inline[1],
        labelIndex,
        labelIndex,
        true,
        false,
        word,
        blocks,
        screenWidth,
        tallest,
        runtime,
      )
      continue
    }
    if (line !== word) continue
    for (const offset of CONDITIONAL_LABEL_OFFSETS) {
      const valueIndex = labelIndex + offset
      if (valueIndex < 0 || valueIndex >= blocks.length) continue
      const value = blocks[valueIndex].text
      if (!runtime.postV2.conditionalLabelShape.matches(cleanCode(value, runtime))) continue
      addCandidate(
        output,
        value,
        valueIndex,
        labelIndex,
        true,
        false,
        word,
        blocks,
        screenWidth,
        tallest,
        runtime,
      )
      break
    }
  }
}

function addCandidate(
  output: CodeCandidate[],
  source: string,
  valueIndex: number,
  scoreIndex: number,
  directCredentialLabel: boolean,
  explicitRule: boolean,
  blacklistExempt: string,
  blocks: readonly PickupOcrBlock[],
  screenWidth: number,
  tallest: number,
  runtime: PickupRuntime,
): void {
  const code = cleanCode(source, runtime)
  if (!isValidCodeShape(code, runtime)
      || runtime.local.code.noise.matches(code)
      || looksLikePrice(code, runtime)
      || isStatusText(code, runtime)) return
  if (!ASCII_CREDENTIAL.test(code)
      && !runtime.postV2.codeFreeformLabel.matches(blocks[scoreIndex]?.text ?? "")) return
  const candidate: CodeCandidate = {
    code,
    valueIndex,
    scoreIndex,
    directCredentialLabel,
    explicitRule,
    blacklistExempt,
    sequence: output.length,
    score: 0,
  }
  candidate.score = scoreCode(candidate, blocks, screenWidth, tallest, runtime)
  output.push(candidate)
}

function scoreCode(
  candidate: CodeCandidate,
  blocks: readonly PickupOcrBlock[],
  screenWidth: number,
  tallest: number,
  runtime: PickupRuntime,
): number {
  let score = 0
  const line = blocks[candidate.scoreIndex]?.text ?? ""
  if (candidate.directCredentialLabel || runtime.scoring.labelPrefix.finds(line)) {
    score += weight(runtime, "label_prefix_hit")
  }
  if (candidate.scoreIndex === tallest) score += weight(runtime, "bbox_big_header")
  const block = blocks[candidate.scoreIndex]
  if (block) {
    const center = (block.left + block.right) / 2
    if (Math.abs(center - screenWidth / 2) <= screenWidth / 6) {
      score += weight(runtime, "horizontally_centered")
    }
  }
  const length = [...candidate.code].length
  if (length >= 3 && length <= 6) score += weight(runtime, "len_3_to_6")
  if (/[A-Za-z]/u.test(candidate.code) && /\d/u.test(candidate.code)) {
    score += weight(runtime, "has_letter_and_digit")
  }
  if (runtime.scoring.codeValueShape.matches(candidate.code)) {
    score += weight(runtime, "code_shape_match")
  }
  if (length > 10) score += weight(runtime, "len_gt_10")
  const near = blocks
    .slice(Math.max(0, candidate.scoreIndex - 1), Math.min(blocks.length, candidate.scoreIndex + 2))
    .map((candidateBlock) => candidateBlock.text)
    .join(" ")
  if (runtime.postV2.blacklistNear.some((token) =>
    token !== candidate.blacklistExempt && near.includes(token))) {
    score += weight(runtime, "near_blacklist_word")
  }
  for (const reject of runtime.scoring.rejects) {
    if (reject.regex.matches(candidate.code)) score += weight(runtime, reject.weightKey)
  }
  return score
}

function selectCodes(ranked: readonly CodeCandidate[]): CodeCandidate[] {
  const selected: CodeCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of ranked) {
    const key = candidate.code.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (selected.length === 0 || (candidate.directCredentialLabel && candidate.score >= 0)) {
      selected.push(candidate)
    }
  }
  return selected.sort((left, right) => left.valueIndex - right.valueIndex || left.sequence - right.sequence)
}

function cleanCode(source: string, runtime: PickupRuntime): string {
  let value = runtime.local.code.labelPrefix.replaceFirst(normalizePickupText(source), "")
  value = runtime.local.code.edgePunctuation.replaceAll(value, "").replace(/\s+/gu, "")
  return runtime.local.code.mergedChineseSlash.replaceFirst(value, "$1.")
}

function repairSelectedCode(source: string): string {
  if (!/[Oo]/u.test(source)
      || CANONICAL_NUMERIC_CODE.test(source)
      || CANONICAL_SEGMENTED_CODE.test(source)) return source
  const repaired = source.replace(/[Oo]/gu, "0")
  return CANONICAL_NUMERIC_CODE.test(repaired) || CANONICAL_SEGMENTED_CODE.test(repaired)
    ? repaired
    : source
}

function isValidCodeShape(source: string, runtime: PickupRuntime): boolean {
  const value = cleanCode(source, runtime)
  const length = [...value].length
  return length >= runtime.local.code.minLength
    && length <= runtime.local.code.maxLength
    && runtime.local.code.allowed.matches(value)
    && !runtime.local.code.noise.matches(value)
    && !runtime.local.code.dateOrTime.matches(value)
}

function bestMerchant(
  baseline: string,
  blocks: readonly PickupOcrBlock[],
  runtime: PickupRuntime,
): MerchantChoice | undefined {
  let best = merchantChoice(baseline, -1, 120, runtime)
  for (let index = 0; index < blocks.length; index += 1) {
    const line = blocks[index].text
    const embedded = embeddedStore(line, runtime)
    const candidate = merchantChoice(embedded || line, index, embedded ? 220 : 100, runtime)
    if (candidate && (!best || candidate.score > best.score
        || (candidate.score === best.score && candidate.index < best.index))) best = candidate
  }
  if (best && best.index < 0) {
    for (let index = 0; index < blocks.length; index += 1) {
      const line = blocks[index].text
      const embedded = embeddedStore(line, runtime)
      const visible = merchantChoice(embedded || line, index, embedded ? 220 : 100, runtime)
      if (visible?.value === best.value) return { ...best, index: visible.index }
    }
  }
  return best
}

function merchantChoice(
  source: string,
  index: number,
  score: number,
  runtime: PickupRuntime,
): MerchantChoice | undefined {
  const embedded = embeddedStore(source, runtime)
  const merchant = embedded || cleanMerchant(source, runtime)
  // Tail closers were discarded by the original cleanup and do not consume its length budget.
  const length = [...merchant.replace(/[)）]+$/u, "")].length
  if (length < runtime.local.merchant.minLength
      || length > runtime.local.merchant.maxLength
      || !runtime.local.merchant.storeSuffix.finds(merchant)
      || runtime.local.merchant.noise.finds(merchant)
      || runtime.local.product.address.matches(merchant)
      || looksLikePrice(merchant, runtime)
      || isStatusText(merchant, runtime)) return undefined
  return { value: merchant, index, score }
}

export function cleanMerchant(source: string, runtime: PickupRuntime): string {
  let value = normalizePickupText(source)
  while (true) {
    const previous = value
    value = runtime.local.merchant.edgePrefix.replaceFirst(value, "")
    value = runtime.local.merchant.edgeSuffix.replaceFirst(value, "")
    if ((value.endsWith(")") || value.endsWith("）"))
        && !missingMerchantParentheses(value.slice(0, -1))) value = value.slice(0, -1).trim()
    if (value === previous) break
  }
  const artifact = firstMatch(runtime.local.merchant.ocrLetterPrefix, value)
  if (artifact) {
    const withoutArtifact = value.slice(artifact.index + artifact[0].length).trim()
    if (runtime.local.merchant.storeSuffix.finds(withoutArtifact)) value = withoutArtifact
  }
  value = value.trim()
  return value + missingMerchantParentheses(value)
}

function missingMerchantParentheses(value: string): string {
  const closers: string[] = []
  for (const character of value) {
    if (character === "(") closers.push(")")
    else if (character === "（") closers.push("）")
    else if (character === ")" || character === "）") closers.pop()
  }
  return closers.reverse().join("")
}

function embeddedStore(source: string, runtime: PickupRuntime): string {
  const match = firstMatch(runtime.local.merchant.embeddedStore, normalizePickupText(source))
  return match?.[1] ? cleanMerchant(match[1], runtime) : ""
}

function claimedRows(selected: readonly CodeCandidate[], merchantRow: number): Set<number> {
  const claimed = new Set<number>()
  for (const candidate of selected) {
    if (candidate.valueIndex >= 0) claimed.add(candidate.valueIndex)
    if (candidate.scoreIndex >= 0) claimed.add(candidate.scoreIndex)
  }
  if (merchantRow >= 0) claimed.add(merchantRow)
  return claimed
}

function baselineProductName(
  blocks: readonly PickupOcrBlock[],
  runtime: PickupRuntime,
): string {
  const extracted = firstExtract(blocks, runtime.base.productName)
  if (extracted) return extracted
  return guessProduct(
    blocks,
    runtime.base.specLine,
    runtime.base.specSkipPrev,
    runtime.base.productTail,
    new Set(),
  )
}

function chooseProduct(
  baseline: string,
  blocks: readonly PickupOcrBlock[],
  selected: readonly CodeCandidate[],
  claimed: ReadonlySet<number>,
  merchantRow: number,
  runtime: PickupRuntime,
): string {
  if (merchantRow >= 0) {
    const scanned = storeScanProducts(blocks, merchantRow, claimed, runtime)
    if (scanned.length > 0) return scanned[0]
  }
  const priced = pricedProducts(blocks, claimed, runtime)
  let product = priced[0] ?? normalizedProduct(
    guessProduct(
      blocks,
      runtime.postV2.specLine,
      runtime.postV2.specSkipPrev,
      runtime.postV2.productTail,
      claimed,
    ),
    runtime,
  )
  if (!product) product = normalizedProduct(baseline, runtime)
  const confirmed = quantityAnchoredProducts(blocks, selected, claimed, runtime)
  if (!product && confirmed.length > 0) product = confirmed[0]
  if (priced.length === 0 && confirmed.length > 0
      && confirmed.includes(product) && product !== confirmed[0]) product = confirmed[0]
  return product
}

function storeScanProducts(
  blocks: readonly PickupOcrBlock[],
  storeRow: number,
  claimedRows: ReadonlySet<number>,
  runtime: PickupRuntime,
): string[] {
  const found: FoundProduct[] = []
  const rows = clusterPickupRows(blocks)
  const storeRowIndex = rows.findIndex((row) => row.includes(storeRow))
  const pageRight = blocks.reduce((maximum, block) => Math.max(maximum, block.right), 1)
  let pending: string | undefined
  let pendingLeft = 0
  let pendingRow = -1
  let specContinuation = false

  for (let rowIndex = storeRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    let purePrice = -1
    let quantityOnly = false
    let subItem = false
    let specHit = false
    let rowCandidate = ""
    let candidateLeft = Number.MIN_SAFE_INTEGER
    let inlineStrong = ""
    const rowText: string[] = []
    let sectionEnd = false

    for (const blockIndex of row) {
      if (claimedRows.has(blockIndex)) continue
      const block = blocks[blockIndex]
      const text = block.text
      if (!text) continue
      rowText.push(text)
      const trimmed = text.trim()
      if (SECTION_BOUNDARY.test(trimmed)) {
        sectionEnd = true
        break
      }
      const hasPrice = text.includes("¥") || text.includes("￥")
      if (hasPrice && NEGATIVE_PRICE.test(trimmed) && PURE_PRICE.test(trimmed)) continue
      if (hasPrice && (PURE_PRICE.test(trimmed) || LABELED_PRICE.test(trimmed))) {
        if (purePrice < 0 || block.left < blocks[purePrice].left) purePrice = blockIndex
        continue
      }
      if (runtime.local.product.quantityOnly.matches(text)) {
        quantityOnly = true
        continue
      }
      if (SUB_ITEM_ROW.test(trimmed)) {
        subItem = true
        continue
      }
      const candidate = normalizedProduct(text, runtime)
      if (runtime.postV2.specLine.finds(text)
          && hasSpecStructure(text)
          && (!candidate || runtime.postV2.specLine.finds(candidate) || isSpecFragment(candidate))) {
        specHit = true
        continue
      }
      if (!candidate) continue
      if (hasPrice) {
        inlineStrong = candidate
        candidateLeft = block.left
      } else if (block.left > candidateLeft) {
        rowCandidate = candidate
        candidateLeft = block.left
      }
    }
    if (sectionEnd) break
    const joined = rowText.join(" ").trim()
    if (!joined) continue
    if (specContinuation) {
      specContinuation = false
      if (closesRoundBracket(joined)) continue
    }
    if (subItem && !inlineStrong && purePrice < 0 && !quantityOnly) continue
    if (inlineStrong) {
      found.push({ order: rowIndex, left: candidateLeft, name: inlineStrong, strong: true })
      pending = undefined
      continue
    }
    if (purePrice >= 0) {
      let candidate = ""
      let bestLeft = Number.MIN_SAFE_INTEGER
      for (const blockIndex of row) {
        if (blockIndex === purePrice || claimedRows.has(blockIndex)) continue
        const block = blocks[blockIndex]
        if (block.left >= blocks[purePrice].left || block.left <= bestLeft) continue
        const value = normalizedProduct(block.text, runtime)
        if (value) {
          candidate = value
          bestLeft = block.left
        }
      }
      if (candidate) {
        found.push({ order: rowIndex, left: bestLeft, name: candidate, strong: true })
        pending = undefined
      } else if (pending) {
        found.push({ order: pendingRow, left: pendingLeft, name: pending, strong: true })
        pending = undefined
      }
      continue
    }
    if (quantityOnly) {
      if (pending) {
        found.push({ order: pendingRow, left: pendingLeft, name: pending, strong: true })
        pending = undefined
      }
      continue
    }
    if (specHit) {
      if (pending) {
        found.push({ order: pendingRow, left: pendingLeft, name: pending, strong: false })
        pending = undefined
      }
      specContinuation = opensRoundBracket(joined)
      continue
    }
    if (rowCandidate) {
      pending = rowCandidate
      pendingLeft = candidateLeft
      pendingRow = rowIndex
    }
  }

  const anyStrong = found.some((candidate) => candidate.strong)
  const tolerance = Math.max(24, Math.trunc(pageRight * 4 / 100))
  const products: string[] = []
  for (const candidate of [...found].sort((left, right) => left.order - right.order)) {
    if (!candidate.strong && anyStrong
        && !found.some((strong) => strong.strong
          && Math.abs(strong.left - candidate.left) <= tolerance)) continue
    if (!products.includes(candidate.name)) products.push(candidate.name)
  }
  return products
}

function pricedProducts(
  blocks: readonly PickupOcrBlock[],
  claimed: ReadonlySet<number>,
  runtime: PickupRuntime,
): string[] {
  const output: string[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    if (claimed.has(index)) continue
    const line = blocks[index].text
    if (!line.includes("¥") && !line.includes("￥")) continue
    if (NEGATIVE_PRICE.test(line.trim()) && PURE_PRICE.test(line.trim())) continue
    let candidate = normalizedProduct(line, runtime)
    if (!candidate && PURE_PRICE.test(line.trim())) {
      let preceding = index - 1
      let steps = 0
      while (preceding >= 0 && steps < 8) {
        if (claimed.has(preceding)) {
          preceding -= 1
          steps += 1
          continue
        }
        const above = blocks[preceding].text
        if (runtime.local.product.quantityOnly.matches(above)
            || PURE_PRICE.test(above.trim())
            || SUB_ITEM_ROW.test(above.trim())) {
          preceding -= 1
          steps += 1
          continue
        }
        candidate = normalizedProduct(above, runtime)
        break
      }
    }
    if (candidate && !output.includes(candidate)) output.push(candidate)
  }
  return output
}

function normalizedProduct(source: string, runtime: PickupRuntime): string {
  let product = cleanProduct(source, runtime)
  product = runtime.postV2.productTail.replaceFirst(product, "").trim()
  const length = [...product].length
  return length >= runtime.local.product.minLength
    && length <= runtime.local.product.maxLength
    && !looksLikePrice(product, runtime)
    && !runtime.local.product.noise.finds(product)
    && !runtime.local.merchant.storeSuffix.finds(cleanMerchant(product, runtime))
    ? product
    : ""
}

function cleanProduct(source: string, runtime: PickupRuntime): string {
  let value = normalizePickupText(source)
  const priceColumn = firstMatch(runtime.local.product.priceColumnStart, value)
  if (priceColumn) value = value.slice(0, priceColumn.index).trim()
  value = runtime.local.product.quantitySuffix.replaceFirst(value, "").trim()
  return runtime.local.product.artPrefix.replaceFirst(value, "").trim()
}

function guessProduct(
  blocks: readonly PickupOcrBlock[],
  spec: PickupPattern,
  skip: PickupPattern,
  tail: PickupPattern,
  claimed: ReadonlySet<number>,
): string {
  for (let index = 0; index < blocks.length; index += 1) {
    if (claimed.has(index) || !spec.finds(blocks[index].text)) continue
    let previous = index - 1
    while (previous >= 0 && (claimed.has(previous) || skip.finds(blocks[previous].text))) {
      previous -= 1
    }
    if (previous < 0) continue
    const candidate = tail.replaceFirst(blocks[previous].text, "").trim()
    const length = [...candidate].length
    if (length >= 2 && length <= 30) return candidate
  }
  return ""
}

function quantityAnchoredProducts(
  blocks: readonly PickupOcrBlock[],
  selected: readonly CodeCandidate[],
  claimed: ReadonlySet<number>,
  runtime: PickupRuntime,
): string[] {
  const products: string[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    if (claimed.has(index) || !runtime.local.product.quantityOnly.matches(blocks[index].text)) continue
    const candidate = adjacentQuantityProduct(blocks, index, -1, selected, claimed, runtime)
      || adjacentQuantityProduct(blocks, index, 1, selected, claimed, runtime)
    if (candidate && !products.includes(candidate)) products.push(candidate)
  }
  return products
}

function adjacentQuantityProduct(
  blocks: readonly PickupOcrBlock[],
  quantityIndex: number,
  direction: -1 | 1,
  selected: readonly CodeCandidate[],
  claimed: ReadonlySet<number>,
  runtime: PickupRuntime,
): string {
  for (let offset = 1; offset <= 3; offset += 1) {
    const index = quantityIndex + direction * offset
    if (index < 0 || index >= blocks.length) break
    if (claimed.has(index)) continue
    let candidate = blocks[index].text
    if (!candidate || runtime.local.product.quantityOnly.matches(candidate)
        || runtime.postV2.specLine.finds(candidate)) continue
    const possibleCode = cleanCode(candidate, runtime)
    if (selected.some((item) => item.code.toUpperCase() === possibleCode.toUpperCase())) continue
    candidate = normalizedProduct(candidate, runtime)
    if (candidate) return candidate
  }
  return ""
}

function firstExtract(
  blocks: readonly PickupOcrBlock[],
  rules: readonly PickupFieldRule[],
): string {
  for (const block of blocks) {
    for (const rule of rules) {
      const value = rule.regex.extractAll(block.text, rule.groupIndex)[0]
      if (value) return value
    }
  }
  return ""
}

function hasSpecStructure(text: string): boolean {
  return SPEC_SEPARATORS.some((separator) =>
    text.split(separator).filter((part) => part.trim()).length >= 3)
}

function roundBrackets(text: string): readonly [number, number] {
  let open = 0
  let close = 0
  for (const character of text) {
    if (character === "(" || character === "（") open += 1
    if (character === ")" || character === "）") close += 1
  }
  return [open, close]
}

function closesRoundBracket(text: string): boolean {
  const [open, close] = roundBrackets(text)
  return close > open
}

function opensRoundBracket(text: string): boolean {
  const [open, close] = roundBrackets(text)
  return open > close
}

function isSpecFragment(text: string): boolean {
  return text.length <= 12
    && ["杯", "冰", "糖", "ml", "ML"].some((word) => text.includes(word))
}

function looksLikePrice(source: string, runtime: PickupRuntime): boolean {
  const value = normalizePickupText(source)
  return runtime.local.product.price.matches(value)
    || runtime.local.product.price.matches(value.replace(/\s+/gu, ""))
}

function isStatusText(source: string, runtime: PickupRuntime): boolean {
  const value = normalizePickupText(source)
  return runtime.completionStatus.finds(value)
    || runtime.cancellationStatus.finds(value)
    || [...runtime.progressStatusWords, ...runtime.terminalStatusWords, ...runtime.postV2.stepWords]
      .some((word) => word && value.includes(word))
}

function isStepRow(runtime: PickupRuntime, line: string): boolean {
  let matches = 0
  for (const word of runtime.postV2.stepWords) {
    if (word && line.includes(word) && ++matches >= runtime.postV2.stepMinHits) return true
  }
  return false
}

function inferBrandFromCode(
  code: string,
  product: string,
  text: string,
  runtime: PickupRuntime,
  strongOverrideOnly: boolean,
): PickupBrandRule | undefined {
  const category = categoryFromText(runtime, `${product}\n${text}`)
  for (const rule of runtime.codeBrandRules) {
    if (strongOverrideOnly && (!rule.requiredProduct || !rule.requiredText)) continue
    if (codeBrandRuleMatches(rule, code.toUpperCase(), product, text, category)) {
      return runtime.brandsById.get(rule.brandId)
    }
  }
  return undefined
}

function codeBrandRuleMatches(
  rule: PickupCodeBrandRule,
  code: string,
  product: string,
  text: string,
  category: string,
): boolean {
  return rule.code.matches(code)
    && (!rule.requiredCategory || rule.requiredCategory === category)
    && (!rule.requiredProduct || rule.requiredProduct.finds(product))
    && (!rule.requiredText || rule.requiredText.finds(text))
    && (!rule.forbiddenText || !rule.forbiddenText.finds(text))
}

function categoryFromText(runtime: PickupRuntime, text: string): string {
  const lower = text.toLocaleLowerCase()
  for (const category of ["coffee", "tea"]) {
    for (const keyword of runtime.categoryKeywords.get(category) ?? []) {
      if (lower.includes(keyword.toLocaleLowerCase())) return category
    }
  }
  return "catering"
}

function tallestIndex(blocks: readonly PickupOcrBlock[]): number {
  let result = -1
  let height = 0
  blocks.forEach((block, index) => {
    const current = Math.max(1, block.bottom - block.top)
    if (current > height) {
      result = index
      height = current
    }
  })
  return result
}

function firstMatch(pattern: PickupPattern, value: string): RegExpExecArray | null {
  return pattern.firstMatch(value)
}

function weight(runtime: PickupRuntime, key: string): number {
  return runtime.scoring.weights.get(key) ?? 0
}

function containsIgnoreCase(source: string, token: string): boolean {
  return source.toLocaleLowerCase().includes(token.toLocaleLowerCase())
}
