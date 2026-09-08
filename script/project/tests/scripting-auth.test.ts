import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  normalizeScriptingToken,
  SCRIPTING_REQUEST_METHOD,
  scriptingCanonicalRequest,
  scriptingCanonicalRequestForMethod,
  scriptingTokenSecret,
} from "../services/scripting-auth";

const token = "AbCdEfGh_123-456";

assert.equal(normalizeScriptingToken(`  ${token}\n`), token);
assert.equal(scriptingTokenSecret(token), token);
assert.equal(normalizeScriptingToken("AbCdEfGh_123-45"), "");
assert.equal(normalizeScriptingToken("AbCdEfGh+123/456"), "");

const canonical = scriptingCanonicalRequest(
  1_777_777_777,
  "0123456789abcdef0123456789abcdef",
  "/api/express/classify",
  "c".repeat(64),
);
assert.equal(
  canonical,
  [
    "scripting-v1",
    "1777777777",
    "0123456789abcdef0123456789abcdef",
    "POST",
    "/api/express/classify",
    "c".repeat(64),
  ].join("\n"),
);
assert.equal(SCRIPTING_REQUEST_METHOD, "POST");

function signature(value: string): string {
  return createHmac("sha256", token).update(value).digest("hex");
}

const baselineSignature = signature(canonical);
const signedFieldVariants = [
  scriptingCanonicalRequest(
    1_777_777_778,
    "0123456789abcdef0123456789abcdef",
    "/api/express/classify",
    "c".repeat(64),
  ),
  scriptingCanonicalRequest(
    1_777_777_777,
    "1123456789abcdef0123456789abcdef",
    "/api/express/classify",
    "c".repeat(64),
  ),
  scriptingCanonicalRequestForMethod(
    1_777_777_777,
    "0123456789abcdef0123456789abcdef",
    "GET",
    "/api/express/classify",
    "c".repeat(64),
  ),
  scriptingCanonicalRequest(
    1_777_777_777,
    "0123456789abcdef0123456789abcdef",
    "/api/express/timeline/preferred",
    "c".repeat(64),
  ),
  scriptingCanonicalRequest(
    1_777_777_777,
    "0123456789abcdef0123456789abcdef",
    "/api/express/classify",
    "d".repeat(64),
  ),
];
for (const variant of signedFieldVariants) {
  assert.notEqual(signature(variant), baselineSignature);
}

console.log("scripting auth contract tests passed");
