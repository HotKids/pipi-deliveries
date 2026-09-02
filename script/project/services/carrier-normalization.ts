type JsonObject = Record<string, unknown>;

export type CarrierNormalization = Readonly<{
  standardCode: string;
  displayName: string;
  kuaidi100Code: string;
  isBuiltIn: boolean;
  tableVersion: string;
}>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown, maximum: number): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate.length <= maximum && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : "";
}

function boolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function candidateFrom(
  value: JsonObject,
  fallbackTableVersion = "",
): CarrierNormalization | null {
  const standardCode = text(value.standardCode, 16).toUpperCase();
  const displayName = text(value.displayName, 64);
  const kuaidi100Code = text(value.kuaidi100Code, 32).toLowerCase();
  const isBuiltIn = boolean(value.isBuiltIn);
  const tableVersion = text(value.tableVersion, 128) || fallbackTableVersion;
  if (
    isBuiltIn == null ||
    (standardCode && !/^[A-Z0-9]{2,16}$/.test(standardCode)) ||
    (kuaidi100Code && !/^[a-z0-9_-]{1,32}$/.test(kuaidi100Code))
  ) {
    return null;
  }
  if (isBuiltIn && (!standardCode || !displayName)) {
    return null;
  }
  return {
    standardCode,
    displayName,
    kuaidi100Code,
    isBuiltIn,
    tableVersion,
  };
}

/**
 * Reads the Worker-owned normalization envelope. The local carrier catalog is
 * deliberately not consulted here: sync ownership belongs to the Worker table.
 */
export function parseCarrierNormalization(
  recordInput: unknown,
  responseInput?: unknown,
): CarrierNormalization | null {
  const record = object(recordInput);
  const response = object(responseInput);
  const responseEnvelope = object(response.carrierNormalization);
  const responseTableVersion = text(
    responseEnvelope.tableVersion ?? response.carrierTableVersion ?? response.tableVersion,
    128,
  );
  // The current Worker writes these fields directly on every sync row. Keep
  // this shape first so a future envelope cannot shadow current authoritative
  // values while a mixed-version rollout is in progress.
  const current: JsonObject = {
    standardCode: record.normalizedCarrierCode ?? record.standardCode,
    displayName: record.normalizedCarrierName ?? record.displayName,
    kuaidi100Code: record.kuaidi100Code,
    isBuiltIn:
      record.carrierBuiltIn ?? record.isBuiltIn ?? record.carrierIsBuiltIn,
    tableVersion:
      record.tableVersion ?? record.carrierTableVersion ?? responseTableVersion,
  };
  const direct = candidateFrom(current);
  if (direct) return direct;

  // Future Workers may move the same contract into a versioned envelope.
  const nested = object(record.carrierNormalization);
  return Object.keys(nested).length
    ? candidateFrom(nested, responseTableVersion)
    : null;
}
