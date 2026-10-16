import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  normalizeScriptingToken,
  SCRIPTING_PROTOCOL_VERSION,
  SCRIPTING_REQUEST_METHOD,
  scriptingActivationHash,
  scriptingCanonicalRequest,
  scriptingCanonicalRequestForMethod,
  scriptingKeyMaterial,
} from "../services/scripting-auth";

const token = "Synthetic_Key_16";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string, value: string) => createHmac("sha256", key).update(value).digest("hex");
assert.equal(normalizeScriptingToken(`  ${token}\n`), token);
assert.equal(normalizeScriptingToken("AbCdEfGh_123-45"), "");
assert.equal(normalizeScriptingToken("AbCdEfGh+123/456"), "");
assert.equal(scriptingKeyMaterial("invalid", sha256, hmac), null);
const material = scriptingKeyMaterial(token, sha256, hmac)!;
assert.equal(material.keyId, "c56af1db3e56d2de2c632b4fe9bc602ee717c363e2448a61253a2600c685bc60");
assert.notEqual(material.keyId, material.macKey);
assert.notEqual(material.keyId, sha256(token));
const activation = scriptingActivationHash("42".repeat(32), sha256);
assert.equal(activation, sha256("pipi-scripting-activation-v1\n" + "42".repeat(32)));
assert.throws(() => scriptingActivationHash("invalid", sha256), /activation/);

const fields = { timestamp: 1_777_777_777, nonce: "0123456789abcdef0123456789abcdef",
  method: "POST", origin: "https://beta.example.invalid", route: "/api/express/classify",
  body: "c".repeat(64), id: material.keyId, activation };
function canonical(value: typeof fields): string {
  return scriptingCanonicalRequestForMethod(value.timestamp, value.nonce, value.method,
    value.origin, value.route, value.body, value.id, value.activation);
}
const expected = ["scripting-v2", "1777777777", fields.nonce, "POST", fields.origin,
  fields.route, fields.body, material.keyId, activation].join("\n");
assert.equal(canonical(fields), expected);
assert.equal(scriptingCanonicalRequest(fields.timestamp, fields.nonce, fields.origin,
  fields.route, fields.body, material.keyId, activation), expected);
assert.equal(SCRIPTING_PROTOCOL_VERSION, "2");
assert.equal(SCRIPTING_REQUEST_METHOD, "POST");
// Retain the original contract vector as historical evidence, not a client downgrade path.
assert.equal(hmac("AbCdEfGhIjKlMnOp", ["scripting-v1", "1790000000",
  "00112233445566778899aabbccddeeff", "POST", "/api/express/carriers", sha256("{}")].join("\n")),
"9a160c2c3c827241637ba4854f972d59f87f1011d030a461a6818dee9f2be670");
for (const change of [
  { timestamp: fields.timestamp + 1 }, { nonce: "11".repeat(16) }, { method: "GET" },
  { origin: "https://formal.example.invalid" }, { route: "/api/express/timeline/preferred" },
  { body: "d".repeat(64) }, { id: "e".repeat(64) }, { activation: "f".repeat(64) },
]) {
  assert.notEqual(hmac(material.macKey, canonical({ ...fields, ...change })),
    hmac(material.macKey, expected));
}
console.log("scripting v2 auth contract tests passed");
