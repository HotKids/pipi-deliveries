import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WEB_TIMELINE_LOAD_TIMEOUT_MS } from "../services/web-timeline";
import { KUAIDI100_H5_TIMEOUT_MS } from "../services/kuaidi100-h5";
import { ACCOUNT_H5_BUDGET_MS } from "../services/account-sync-policy";

// Audit R6 / user default #12 (2026-09-25): the K100 and JT page captures use one 8-second budget on
// every client (parity doc: 8 s); the iOS page loader used to allow 10.
assert.equal(WEB_TIMELINE_LOAD_TIMEOUT_MS, 8_000);
assert.equal(KUAIDI100_H5_TIMEOUT_MS, 8_000);
assert.equal(ACCOUNT_H5_BUDGET_MS, 8_000);
const source = readFileSync(new URL("../services/web-timeline.ts", import.meta.url), "utf8");
assert.match(source, /remainingTimeoutMs\(\s*input\.deadlineAtMs,\s*LOAD_TIMEOUT_MS,/,
  "the page loader caps every caller's deadline with that budget");
assert.match(source, /const LOAD_TIMEOUT_MS = WEB_TIMELINE_LOAD_TIMEOUT_MS;/);

console.log("H5 capture budget tests passed");
