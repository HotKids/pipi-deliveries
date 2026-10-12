import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCarrierAuthorityPayload } from "../services/carrier-authority";
import { installCarrierQueryRecords, resetCarrierQueryRecordsForTesting } from "../services/carrier-query";

// Audit C5 (adopted 2026-09-25): one validation contract for the Worker's carrier authority snapshot,
// read from the Worker-generated shared fixture. It checks structure, types and namespace conflicts,
// never table content, so a legitimate edit (a hyphenated hotline, a renamed HTKY) is accepted.
const shared = JSON.parse(readFileSync(
  new URL("./fixtures/express/carrier-table-validation.v1.json", import.meta.url), "utf8"));

function apply(base: unknown, operations: readonly Record<string, unknown>[]): Record<string, unknown> {
  const table = structuredClone(base) as Record<string, unknown>;
  for (const operation of operations) {
    const path = (operation.set ?? operation.delete) as (string | number)[];
    let parent = table as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const key = path[path.length - 1];
    if (operation.set) parent[key] = structuredClone(operation.value);
    else if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  }
  return table;
}

assert.ok(shared.cases.length >= 30);
for (const item of shared.cases) {
  const payload = parseCarrierAuthorityPayload(apply(shared.base, item.operations));
  assert.equal(payload != null, item.valid, item.name);
  // Whatever the parser accepts must also install, or a refresh would store a table it cannot use.
  if (payload) {
    assert.equal(installCarrierQueryRecords(payload.entries, payload.version, payload.source), true, item.name);
    resetCarrierQueryRecordsForTesting();
  }
}

// User decision 2026-09-25 (audit C5 follow-up 2): `source` follows the Worker's rule, a non-empty
// string of at most 128 characters, with no character-set restriction of its own.
const withSource = (source: unknown) => ({ ...shared.base, source });
assert.ok(parseCarrierAuthorityPayload(withSource("x".repeat(128))));
assert.equal(parseCarrierAuthorityPayload(withSource("x".repeat(129))), null);
assert.equal(parseCarrierAuthorityPayload(withSource("   ")), null);
assert.ok(parseCarrierAuthorityPayload(withSource("Worker 承运商权威表")));
assert.deepEqual(shared.entryCount, { min: 17, max: 256 });

console.log("shared carrier table validation tests passed");
