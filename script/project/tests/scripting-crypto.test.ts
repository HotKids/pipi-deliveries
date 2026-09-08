import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

type FakeData = { value: string };

Object.assign(globalThis, {
  Data: {
    fromIntArray: () => ({ value: "" }),
    fromRawString: (value: string) => ({ value }),
  },
  Crypto: {
    sha256: (data: FakeData) => ({
      toHexString: () => createHash("sha256").update(data.value).digest("hex"),
    }),
    hmacSHA256: (data: FakeData, key: FakeData) => ({
      toHexString: () => createHmac("sha256", key.value)
        .update(data.value)
        .digest("hex")
        .toUpperCase(),
    }),
  },
});

const {
  detectHmacVariant,
  scriptingCryptoRuntimeLabel,
  scriptingHmacSha256Hex,
  scriptingSha256Valid,
} = await import("../services/scripting-crypto");

assert.equal(scriptingSha256Valid(), true);
assert.equal(scriptingCryptoRuntimeLabel(), "data-key");
assert.equal(
  scriptingHmacSha256Hex("synthetic-key", "synthetic-message"),
  createHmac("sha256", "synthetic-key")
    .update("synthetic-message")
    .digest("hex"),
);

assert.equal(detectHmacVariant((first, second) => {
  const key = first as unknown as FakeData;
  const data = second as unknown as FakeData;
  return createHmac("sha256", key.value).update(data.value).digest("hex");
}), "key-data");

console.log("scripting crypto compatibility tests passed");
