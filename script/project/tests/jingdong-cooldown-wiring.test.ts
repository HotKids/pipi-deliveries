import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// AGENTS §9 (2026-09-04 复核后修正): every union-page load rests the order for ten minutes, an
// hour after risk control, and no user action lifts either rest. These are source contracts
// because the wiring lives inside `runShipmentRefreshById`, which has no seam to call directly.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sync = readFileSync(join(projectRoot, "services/sync.ts"), "utf8");
const storage = readFileSync(join(projectRoot, "services/storage.ts"), "utf8");
const policy = readFileSync(
  join(projectRoot, "services/account-sync-policy.ts"),
  "utf8",
);

// I2: the retry decision no longer takes a force flag, and no caller passes one.
assert.equal(/force\s*=\s*false/.test(policy), false);
assert.equal(policy.includes("if (force) return true;"), false);
assert.equal(
  /shouldRetryAccountOrderProjection\([^)]*forceAccountOrderProjection/s.test(sync),
  false,
  "no caller may pass a force flag into the projection cooldown decision",
);

// I3: the rest is recorded after any load, not only after a timeline reopen.
const restAssignment = sync.search(
  /reopenRetry = projectionFailureRetry\(\s*\n\s*routeHash,/,
);
const reopenBranch = sync.indexOf("if (reopenForTimeline) {\n                    if (");
assert.ok(restAssignment > 0, "the rest record must be written after the load");
assert.ok(
  reopenBranch < 0 || restAssignment < reopenBranch,
  "the rest record must be written before the reopen-only handling",
);
assert.match(
  sync,
  /if \(reopenRetry\) \{[\s\S]{0,400}jingDongH5Retry: reopenRetry/,
  "the commit must persist the rest record for first projections too",
);

// I1: both cooldown records survive the migration that runs on every save and load.
assert.match(
  storage,
  /riskControlAtMs: validRiskControlAtMs/,
  "the risk-control stamp must survive migrateShipmentSource",
);
assert.match(
  storage,
  /const jingDongH5Retry = \/\^\[a-f0-9\]\{64\}\$\/\.test\(reopenRouteHash\)/,
  "the reopen cooldown must be rebuilt, not dropped, by migrateShipmentSource",
);
assert.match(storage, /\n {6}jingDongH5Retry,\n/);

// I5: a carrier repair may neither hide a projection error nor compare against itself.
const errorGate = sync.indexOf("if (!changed && accountError &&");
const repairChanged = sync.indexOf("if (storedRowBaseline) changed = true;");
assert.ok(errorGate > 0 && repairChanged > 0);
assert.ok(
  errorGate < repairChanged,
  "the account error must be raised before a carrier repair marks the refresh as changed",
);
assert.match(
  sync,
  /shipmentEffectiveFingerprint\(storedRowBaseline \|\| original\)/,
  "the commit fence must compare against the stored row, not the repaired one",
);
assert.equal(
  /carrierRepair = recognition\.normalization;[\s\S]{0,200}changed = true;/.test(sync),
  false,
  "the repair itself must not set changed at recognition time",
);

console.log("jingdong cooldown wiring tests passed");
