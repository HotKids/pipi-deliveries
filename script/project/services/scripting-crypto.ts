import { utf8Data } from "./scripting-data";

export type ScriptingHmacVariant = "data-key" | "key-data";

type HmacHex = (first: Data, second: Data) => string;

const SELF_TEST_KEY = "pipi-scripting-self-test-key";
const SELF_TEST_MESSAGE = "pipi-scripting-self-test-message";
const SELF_TEST_HMAC =
  "4f40cf0719b6746784492fa2688fd9d96a5d82ee2df721b94cf22f2f7f1fe7d0";
const SELF_TEST_SHA256 =
  "5a49c3067f1b49027861f4c6d562a484b090b20997e0099c4ff90a24deb4957b";

let cachedVariant: ScriptingHmacVariant | null = null;
let cachedSha256Valid: boolean | null = null;

function normalizedHex(value: string, length: number): string {
  const clean = String(value || "").trim().toLowerCase();
  return clean.length === length && /^[0-9a-f]+$/.test(clean) ? clean : "";
}

function runtimeHmacHex(first: Data, second: Data): string {
  return Crypto.hmacSHA256(first, second).toHexString();
}

export function detectHmacVariant(
  hmacHex: HmacHex = runtimeHmacHex,
): ScriptingHmacVariant {
  const message = utf8Data(SELF_TEST_MESSAGE);
  const key = utf8Data(SELF_TEST_KEY);
  try {
    if (normalizedHex(hmacHex(message, key), 64) === SELF_TEST_HMAC) {
      return "data-key";
    }
  } catch {
    /* try the alternate host API ordering below */
  }
  try {
    if (normalizedHex(hmacHex(key, message), 64) === SELF_TEST_HMAC) {
      return "key-data";
    }
  } catch {
    /* reported as an unsupported runtime below */
  }
  throw new Error("Scripting HMAC self-test failed");
}

export function scriptingSha256Valid(): boolean {
  if (cachedSha256Valid != null) return cachedSha256Valid;
  try {
    cachedSha256Valid = normalizedHex(
      Crypto.sha256(utf8Data(SELF_TEST_MESSAGE)).toHexString(),
      64,
    ) === SELF_TEST_SHA256;
  } catch {
    cachedSha256Valid = false;
  }
  return cachedSha256Valid;
}

export function scriptingHmacVariant(): ScriptingHmacVariant {
  if (!cachedVariant) cachedVariant = detectHmacVariant();
  return cachedVariant;
}

export function scriptingHmacSha256Hex(key: string, value: string): string {
  if (!scriptingSha256Valid()) {
    throw new Error("Scripting SHA-256 self-test failed");
  }
  const data = utf8Data(value);
  const keyData = utf8Data(key);
  const digest = scriptingHmacVariant() === "data-key"
    ? Crypto.hmacSHA256(data, keyData)
    : Crypto.hmacSHA256(keyData, data);
  const hex = normalizedHex(digest.toHexString(), 64);
  if (!hex) throw new Error("Scripting HMAC output is invalid");
  return hex;
}

export function scriptingCryptoRuntimeLabel(): string {
  try {
    if (!scriptingSha256Valid()) return "sha256-invalid";
    return scriptingHmacVariant();
  } catch {
    return "hmac-invalid";
  }
}
