import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

type FakeData = { value: string };
Object.assign(globalThis, {
  Data: { fromRawString: (value: string) => ({ value }) },
  Crypto: {
    sha256: (value: FakeData) => ({ toHexString: () => createHash("sha256").update(value.value).digest("hex") }),
    hmacSHA256: (value: FakeData, key: FakeData) => ({ toHexString: () => createHmac("sha256", key.value).update(value.value).digest("hex") }),
  },
});
const { scriptingAuthHeaders, GatewayError, SCRIPTING_UPDATE_REQUIRED_MESSAGE } = await import("../services/gateway");
const { SCRIPT_BUILD_TRACK, GATEWAY_ORIGIN, SCRIPTING_GATEWAY_PROTOCOL_VERSION } = await import("../services/build-track");
const token = "AbCdEfGh_123-456", activation = "42".repeat(32);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = Date.parse("2026-10-16T12:00:00+08:00"), timestamp = Math.floor(now / 1000);
const nonce = "01".repeat(16), route = "/api/express/carriers", body = "{}";
assert.equal(SCRIPT_BUILD_TRACK, "formal");
assert.equal(GATEWAY_ORIGIN, "https://pipiassistant.app");
assert.equal(SCRIPTING_GATEWAY_PROTOCOL_VERSION, "2");
const headers = scriptingAuthHeaders(token, timestamp, nonce, route, hash(body), activation);
assert.equal(headers["X-Scripting-Version"], "2", "The formal distribution must select the promoted Worker's highest protocol");
const root = hash(token), keyId = hash("pipi-scripting-key-id-v2\n" + root);
const macKey = createHmac("sha256", root).update("pipi-scripting-request-mac-v2").digest("hex");
const activationHash = hash("pipi-scripting-activation-v1\n" + activation);
assert.deepEqual(headers, {
  "X-Scripting-Version": "2", "X-Scripting-Key-Id": keyId, "X-Scripting-Activation": activationHash,
  "X-Scripting-Timestamp": String(timestamp), "X-Scripting-Nonce": nonce,
  "X-Scripting-Signature": createHmac("sha256", macKey)
    .update(["scripting-v2", String(timestamp), nonce, "POST", GATEWAY_ORIGIN, route,
      hash(body), keyId, activationHash].join("\n")).digest("hex"),
});
assert.deepEqual(scriptingAuthHeaders(token, timestamp, nonce, route, hash(body), activation, "1"), {
  "X-Scripting-Version": "1", "X-Scripting-Token": token, "X-Scripting-Activation": activation,
  "X-Scripting-Timestamp": String(timestamp), "X-Scripting-Nonce": nonce,
  "X-Scripting-Signature": createHmac("sha256", token)
    .update(["scripting-v1",String(timestamp),nonce,"POST",route,hash(body)].join("\n")).digest("hex"),
});
const expires = Date.parse("2026-11-01T00:00:00+08:00") / 1000;
assert.equal(scriptingAuthHeaders(token,expires-1,nonce,route,hash(body),activation,"1")["X-Scripting-Version"],"1");
assert.throws(()=>scriptingAuthHeaders(token,expires,nonce,route,hash(body),activation,"1"),
  (error:unknown)=>error instanceof GatewayError && error.message===SCRIPTING_UPDATE_REQUIRED_MESSAGE);
assert.throws(()=>scriptingAuthHeaders(token,expires+1,nonce,route,hash(body),activation,"1"),GatewayError);
const after = scriptingAuthHeaders(token,expires+1,nonce,route,hash(body),activation);
assert.equal(after["X-Scripting-Version"],"2");assert.equal("X-Scripting-Token" in after,false);
assert.equal(after["X-Scripting-Activation"],hash("pipi-scripting-activation-v1\n"+activation));
console.log("The formal script preserves its selected protocol, exact headers and fixed retirement boundary");
