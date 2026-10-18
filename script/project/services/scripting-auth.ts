export const SCRIPTING_PROTOCOL_VERSION = "2";
export const SCRIPTING_REQUEST_METHOD = "POST";
export const SCRIPTING_LEGACY_EXPIRES_AT_SECONDS =
  Date.parse("2026-11-01T00:00:00+08:00") / 1000;

export const SCRIPTING_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{16}$/;

export function normalizeScriptingToken(value: string): string {
  const token = value.trim();
  return SCRIPTING_TOKEN_PATTERN.test(token) ? token : "";
}

/** Retained six-line v1 compatibility contract until the fixed legacy retirement. */
export function scriptingLegacyCanonicalRequest(
  timestamp: number,
  nonce: string,
  route: string,
  bodySha256: string,
): string {
  return ["scripting-v1", String(timestamp), nonce.trim(), SCRIPTING_REQUEST_METHOD,
    route.trim(), bodySha256.trim()].join("\n");
}

export function scriptingKeyMaterial(
  tokenInput: string,
  sha256Hex: (value: string) => string,
  hmacSha256Hex: (key: string, value: string) => string,
): { keyId: string; macKey: string } | null {
  const token = normalizeScriptingToken(tokenInput);
  if (!token) return null;
  const root = sha256Hex(token);
  return {
    keyId: sha256Hex(`pipi-scripting-key-id-v2\n${root}`),
    macKey: hmacSha256Hex(root, "pipi-scripting-request-mac-v2"),
  };
}

export function scriptingActivationHash(
  identity: string,
  sha256Hex: (value: string) => string,
): string {
  if (!/^[0-9a-f]{64}$/.test(identity)) throw new Error("Invalid Scripting activation");
  return sha256Hex(`pipi-scripting-activation-v1\n${identity}`);
}

/**
 * The Worker verifies this exact field order and reserves each accepted nonce
 * once. The client only generates and signs the nonce; replay rejection is a
 * server-side guarantee and must remain fail-closed there.
 */
export function scriptingCanonicalRequestForMethod(
  timestamp: number,
  nonce: string,
  method: string,
  origin: string,
  route: string,
  bodySha256: string,
  keyId: string,
  activationHash: string,
): string {
  return [
    `scripting-v${SCRIPTING_PROTOCOL_VERSION}`,
    String(timestamp),
    nonce.trim(),
    method.trim().toUpperCase(),
    origin,
    route.trim(),
    bodySha256.trim(),
    keyId,
    activationHash,
  ].join("\n");
}

export function scriptingCanonicalRequest(
  timestamp: number,
  nonce: string,
  origin: string,
  route: string,
  bodySha256: string,
  keyId: string,
  activationHash: string,
): string {
  return scriptingCanonicalRequestForMethod(
    timestamp,
    nonce,
    SCRIPTING_REQUEST_METHOD,
    origin,
    route,
    bodySha256,
    keyId,
    activationHash,
  );
}
