export const SCRIPTING_PROTOCOL_VERSION = "1";
export const SCRIPTING_REQUEST_METHOD = "POST";

export const SCRIPTING_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{16}$/;

export function normalizeScriptingToken(value: string): string {
  const token = value.trim();
  return SCRIPTING_TOKEN_PATTERN.test(token) ? token : "";
}

/**
 * Protocol v1 uses the bearer token itself as the HMAC key and also sends it in
 * X-Scripting-Token. The HMAC binds a request for a legitimate token holder,
 * but it does not keep the token confidential or protect it after disclosure.
 * Changing this derivation requires a coordinated Worker and token-issuer
 * rollout; it cannot be changed by the script alone.
 */
export function scriptingTokenSecret(tokenInput: string): string {
  return normalizeScriptingToken(tokenInput);
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
  route: string,
  bodySha256: string,
): string {
  return [
    `scripting-v${SCRIPTING_PROTOCOL_VERSION}`,
    String(timestamp),
    nonce.trim(),
    method.trim().toUpperCase(),
    route.trim(),
    bodySha256.trim(),
  ].join("\n");
}

export function scriptingCanonicalRequest(
  timestamp: number,
  nonce: string,
  route: string,
  bodySha256: string,
): string {
  return scriptingCanonicalRequestForMethod(
    timestamp,
    nonce,
    SCRIPTING_REQUEST_METHOD,
    route,
    bodySha256,
  );
}
