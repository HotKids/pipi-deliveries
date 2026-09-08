import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export type CarrierQueryRecord = {
  standardCode: string;
  displayName: string;
  kuaidi100Code: string;
  kuaidi100CodeAliases: readonly string[];
  hotline: string;
  iconKey: string;
  requiresPhoneTail: boolean;
  aliases: readonly string[];
  codePrefixAliases: readonly string[];
  nameAliases: readonly string[];
};

export function normalizeCarrierCode(value: string): string {
  return String(value || "").trim().toUpperCase();
}

type CarrierIndexes = Readonly<{
  version: string;
  source: string;
  records: readonly CarrierQueryRecord[];
  byStandardCode: ReadonlyMap<string, CarrierQueryRecord>;
  byRawCpCode: ReadonlyMap<string, CarrierQueryRecord>;
  byKuaidi100Code: ReadonlyMap<string, CarrierQueryRecord>;
  byPrefix: readonly Readonly<{ prefix: string; record: CarrierQueryRecord }>[];
  byName: ReadonlyMap<string, CarrierQueryRecord>;
}>;

export const BOOTSTRAP_TABLE_VERSION =
  "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e";
export const BOOTSTRAP_TABLE_SOURCE = "embedded-transition";

function normalizeCarrierName(value: string): string {
  return String(value || "").replace(/\s+/g, "").trim();
}

function stringList(value: readonly string[], pattern?: RegExp): string[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const clean = item.trim();
    if (!clean || clean.length > 64 || (pattern && !pattern.test(clean))) return null;
    if (!result.includes(clean)) result.push(clean);
  }
  return result;
}

function validatedRecord(value: CarrierQueryRecord): CarrierQueryRecord | null {
  if (!value || typeof value !== "object") return null;
  const standardCode = normalizeCarrierCode(value.standardCode);
  const displayName = String(value.displayName || "").trim();
  const kuaidi100Code = String(value.kuaidi100Code || "").trim().toLowerCase();
  const hotline = String(value.hotline || "").trim();
  const iconKey = String(value.iconKey || "").trim().toLowerCase();
  const aliases = stringList(value.aliases);
  const kuaidi100CodeAliases = stringList(value.kuaidi100CodeAliases || []);
  const codePrefixAliases = stringList(value.codePrefixAliases || [], /^[A-Za-z0-9]+$/);
  const nameAliases = stringList(value.nameAliases);
  if (!/^[A-Z0-9]{2,16}$/.test(standardCode) || !displayName || displayName.length > 64 ||
    !/^[a-z0-9_-]{1,32}$/.test(kuaidi100Code) || hotline.length > 32 ||
    !/^[a-z0-9_-]{1,32}$/.test(iconKey) ||
    typeof value.requiresPhoneTail !== "boolean" || !aliases ||
    !kuaidi100CodeAliases || !codePrefixAliases || !nameAliases) return null;
  return Object.freeze({
    standardCode,
    displayName,
    kuaidi100Code,
    kuaidi100CodeAliases: Object.freeze(kuaidi100CodeAliases),
    hotline,
    iconKey,
    requiresPhoneTail: value.requiresPhoneTail,
    aliases: Object.freeze(aliases),
    codePrefixAliases: Object.freeze(codePrefixAliases.map(normalizeCarrierCode)),
    nameAliases: Object.freeze(nameAliases),
  });
}

function buildCarrierIndexes(
  values: readonly CarrierQueryRecord[],
  versionInput: string,
  sourceInput: string,
): CarrierIndexes | null {
  const version = String(versionInput || "").trim();
  const source = String(sourceInput || "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(version) ||
    !source || source.length > 256 || !/^[\x20-\x7E]+$/.test(source)) return null;
  if (!Array.isArray(values) || values.length < 17 || values.length > 256) return null;
  const records: CarrierQueryRecord[] = [];
  const standardCodes = new Set<string>();
  for (const value of values) {
    const record = validatedRecord(value);
    if (!record || standardCodes.has(record.standardCode)) return null;
    standardCodes.add(record.standardCode);
    records.push(record);
  }
  const byStandardCode = new Map<string, CarrierQueryRecord>();
  const byRawCpCode = new Map<string, CarrierQueryRecord>();
  const byKuaidi100Code = new Map<string, CarrierQueryRecord>();
  for (const record of records) {
    const standardKey = normalizeCarrierCode(record.standardCode);
    const rawExisting = byRawCpCode.get(standardKey);
    if (!standardKey || byStandardCode.has(standardKey) ||
      (rawExisting && rawExisting.standardCode !== record.standardCode)) return null;
    byStandardCode.set(standardKey, record);
    byRawCpCode.set(standardKey, record);

    const kuaidi100Key = record.kuaidi100Code.trim().toLowerCase();
    const kuaidi100Existing = byKuaidi100Code.get(kuaidi100Key);
    if (!kuaidi100Key ||
      (kuaidi100Existing && kuaidi100Existing.standardCode !== record.standardCode)) {
      return null;
    }
    byKuaidi100Code.set(kuaidi100Key, record);
  }
  for (const record of records) {
    for (const alias of record.aliases) {
      const key = normalizeCarrierCode(alias);
      const existing = byRawCpCode.get(key);
      if (!key || (existing && existing.standardCode !== record.standardCode)) return null;
      byRawCpCode.set(key, record);
    }
    for (const alias of record.kuaidi100CodeAliases) {
      const key = alias.trim().toLowerCase();
      const existing = byKuaidi100Code.get(key);
      if (!key || (existing && existing.standardCode !== record.standardCode)) return null;
      byKuaidi100Code.set(key, record);
    }
  }
  const byPrefix: Array<Readonly<{ prefix: string; record: CarrierQueryRecord }>> = [];
  const prefixOwners = new Map<string, string>();
  for (const record of records) {
    for (const value of record.codePrefixAliases) {
      const prefix = normalizeCarrierCode(value);
      const owner = prefixOwners.get(prefix);
      if (!prefix || (owner && owner !== record.standardCode)) return null;
      if (byPrefix.some((existing) =>
        existing.record.standardCode !== record.standardCode &&
        (existing.prefix.startsWith(prefix) || prefix.startsWith(existing.prefix)))) {
        return null;
      }
      if (!owner) {
        prefixOwners.set(prefix, record.standardCode);
        byPrefix.push(Object.freeze({ prefix, record }));
      }
    }
  }
  const byName = new Map<string, CarrierQueryRecord>();
  for (const record of records) {
    for (const name of [record.displayName, ...record.nameAliases]) {
      const key = normalizeCarrierName(name);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, record);
    }
  }
  return Object.freeze({
    version,
    source,
    records: Object.freeze(records),
    byStandardCode,
    byRawCpCode,
    byKuaidi100Code,
    byPrefix: Object.freeze(byPrefix),
    byName,
  });
}

function bootstrapRecords(): CarrierQueryRecord[] {
  return EXPRESS_POLICY.carrierQuery.records.map((value) => {
    const kuaidi100CodeAliases = "kuaidi100CodeAliases" in value
      ? value.kuaidi100CodeAliases
      : [];
    const codePrefixAliases = "codePrefixAliases" in value
      ? value.codePrefixAliases
      : [];
    return {
      standardCode: value.standardCode,
      displayName: value.displayName,
      kuaidi100Code: value.kuaidi100Code,
      kuaidi100CodeAliases,
      hotline: value.hotline,
      iconKey: value.iconKey,
      requiresPhoneTail: value.requiresPhoneTail,
      aliases: value.aliases,
      codePrefixAliases,
      nameAliases: value.nameAliases,
    };
  });
}

const BOOTSTRAP_INDEXES = buildCarrierIndexes(
  bootstrapRecords(),
  BOOTSTRAP_TABLE_VERSION,
  BOOTSTRAP_TABLE_SOURCE,
);
if (!BOOTSTRAP_INDEXES) throw new Error("Invalid built-in carrier table");
let ACTIVE_INDEXES = BOOTSTRAP_INDEXES;

/** Atomically replaces every carrier lookup index after validating the entire snapshot. */
export function installCarrierQueryRecords(
  values: readonly CarrierQueryRecord[],
  version = BOOTSTRAP_TABLE_VERSION,
  source = BOOTSTRAP_TABLE_SOURCE,
): boolean {
  const next = buildCarrierIndexes(values, version, source);
  if (!next) return false;
  ACTIVE_INDEXES = next;
  return true;
}

export function validateCarrierQueryRecords(
  values: readonly CarrierQueryRecord[],
  version: string,
): boolean {
  return buildCarrierIndexes(values, version, "validation") != null;
}

export function resetCarrierQueryRecordsForTesting(): void {
  ACTIVE_INDEXES = BOOTSTRAP_INDEXES;
}

export function activeCarrierQueryRecords(): readonly CarrierQueryRecord[] {
  return ACTIVE_INDEXES.records;
}

export function activeCarrierTableVersion(): string {
  return ACTIVE_INDEXES.version;
}

export function activeCarrierTableSource(): string {
  return ACTIVE_INDEXES.source;
}

export function resolveCarrierQuery(
  code: string,
): CarrierQueryRecord | null {
  return ACTIVE_INDEXES.byStandardCode.get(normalizeCarrierCode(code)) || null;
}

/** Resolves only codes returned by Kuaidi100, including its reverse-only aliases. */
export function resolveCarrierKuaidi100Code(
  code: string,
): CarrierQueryRecord | null {
  return ACTIVE_INDEXES.byKuaidi100Code.get(
    String(code || "").trim().toLowerCase(),
  ) || null;
}

export function resolveCarrierName(name: string): CarrierQueryRecord | null {
  return ACTIVE_INDEXES.byName.get(normalizeCarrierName(name)) || null;
}

/** Resolves one raw upstream cpCode, including approved trailing-* prefix rules. */
export function resolveCarrierCpCode(
  code: string,
): CarrierQueryRecord | null {
  const normalized = normalizeCarrierCode(code);
  for (const candidate of ACTIVE_INDEXES.byPrefix) {
    if (normalized.startsWith(candidate.prefix)) return candidate.record;
  }
  return ACTIVE_INDEXES.byRawCpCode.get(normalized) || null;
}

export function queryPhoneTails(
  record: CarrierQueryRecord | null,
  explicitTail: string,
  boundTails: readonly string[],
): string[] {
  const supplied = [explicitTail, ...boundTails]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  return record?.requiresPhoneTail ? supplied : ["", ...supplied];
}
