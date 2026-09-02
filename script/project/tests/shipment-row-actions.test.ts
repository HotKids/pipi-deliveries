import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rowSource = await readFile(
  resolve(projectDir, "components/ShipmentRow.tsx"),
  "utf8",
);
const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);

assert.match(
  rowSource,
  /const \[pendingAction, setPendingAction\] = useState<[\s\S]*?"delete" \| "complete" \| null[\s\S]*?>\(null\)/,
  "each shipment row must own its pending action",
);
assert.match(
  rowSource,
  /<HStack[\s\S]*?confirmationDialog=\{\{[\s\S]*?isPresented: pendingAction != null/,
  "the confirmation dialog must be anchored to the shipment row",
);
assert.match(
  rowSource,
  /title="签收"[\s\S]*?action=\{\(\) => setPendingAction\("complete"\)\}/,
);
assert.match(
  rowSource,
  /title="删除"[\s\S]*?action=\{\(\) => setPendingAction\("delete"\)\}/,
);
assert.match(
  rowSource,
  /function confirmPendingAction\(\)[\s\S]*?setPendingAction\(null\)[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?props\.onDelete\(\)[\s\S]*?props\.onForceComplete\(\)[\s\S]*?\}, 350\)/,
  "the row must dismiss its native confirmation dialog before mutating or removing the anchor row",
);
assert.doesNotMatch(
  homeSource,
  /pendingSwipeAction|confirmationDialog=/,
  "Home must not own a page-level swipe confirmation dialog",
);
assert.match(homeSource, /onDelete=\{\(\) => remove\(shipment\.identity\.id\)\}/);
assert.match(
  homeSource,
  /onForceComplete=\{\(\) => forceComplete\(shipment\.identity\.id\)\}/,
);

console.log("shipment-row-actions tests passed");
