import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const { emptyState, loadState, saveState, removeShipment, visibleShipments } = await import("../services/storage");
const { cachedProductImage, productImageCacheKey, productImageCachePath,
  rememberProductImage } = await import("../services/product-image-cache");
const DAY = 86_400_000;
const signedAt = NOW - 60_000;
const timeText = new Date(signedAt + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
function row(id: string): Shipment {
  return {
    identity: { id, bindingSource: "interface5", sourceOwner: "account", sourceId: id,
      phone: "13800000000", phoneTail: "0000", courierCode: "JD", rawCourierCode: "JD",
      companyName: "JD", manuallyAdded: false, createdAtMs: signedAt, enhancedMode: true,
      productImageURL: "https://img.jd.com/synthetic.jpg" },
    timeline: { provider: "v5_query", waybill: `JD${id}`, courierCode: "JD", companyName: "JD",
      semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: signedAt, latestTimeText: timeText,
      latestDetail: "Signed", tracks: [{ timeText, timeMs: signedAt, detail: "Signed", statusCode: "107", raw: {} }],
      successAtMs: NOW },
    updatedAtMs: NOW,
  };
}
function seedImage(shipment: Shipment) {
  const key = productImageCacheKey(shipment.identity);
  const path = productImageCachePath(key);
  memory.set(`file:${path}`, "synthetic encoded image");
  rememberProductImage(key, { syntheticImage: true } as unknown as UIImage);
  return { key, path };
}

memory.clear();
const signed = row("retained-image");
saveState({ ...emptyState(), shipments: [signed] }, NOW);
const image = seedImage(signed);
const hidden = loadState(NOW + 15 * DAY);
assert.equal(visibleShipments(hidden, NOW + 15 * DAY).length, 0);
assert.equal(hidden.shipments.length, 1, "a display-hidden row remains in the stored retention window");
assert.ok(memory.has(`file:${image.path}`), "hiding a row does not remove its persistent image");
assert.ok(cachedProductImage(image.key));
assert.equal(loadState(NOW + 22 * DAY).shipments.length, 0);
assert.equal(memory.has(`file:${image.path}`), false, "load-time retention removes the expired row's image");
assert.equal(cachedProductImage(image.key), null);

memory.clear();
const deleted = row("deleted-image");
saveState({ ...emptyState(), shipments: [deleted] }, NOW);
const deletedImage = seedImage(deleted);
assert.equal(removeShipment(deleted.identity.id, NOW + 1).shipments.length, 0);
assert.equal(memory.has(`file:${deletedImage.path}`), false, "explicit deletion clears the persistent image");
assert.equal(cachedProductImage(deletedImage.key), null);

memory.clear();
const writeExpired = row("save-expired-image");
saveState({ ...emptyState(), shipments: [writeExpired] }, NOW);
const expiredImage = seedImage(writeExpired);
saveState({ ...loadState(NOW), shipments: [writeExpired] }, NOW + 22 * DAY);
assert.equal(memory.has(`file:${expiredImage.path}`), false, "save-time retention removes an expired image too");

memory.clear();
const unavailable = row("optional-cleanup");
saveState({ ...emptyState(), shipments: [unavailable] }, NOW);
const optional = seedImage(unavailable);
const originalRemove = FileManager.removeSync;
try {
  FileManager.removeSync = (path: string) => {
    if (path === optional.path) throw new Error("synthetic image cleanup denied");
    originalRemove(path);
  };
  assert.equal(removeShipment(unavailable.identity.id, NOW + 1).shipments.length, 0,
    "an optional image cleanup failure cannot fail or roll back a durable shipment deletion");
  assert.equal(loadState(NOW + 1).shipments.length, 0);
} finally { FileManager.removeSync = originalRemove; }
assert.ok(memory.has(`file:${optional.path.replace(/\.img$/, ".deleted")}`),
  "an unsuccessful optional cleanup leaves a durable marker naming the exact immutable file");
loadState(NOW + 2);
assert.equal(memory.has(`file:${optional.path}`), false, "a later state read retries cleanup after its row is gone");
assert.equal(memory.has(`file:${optional.path.replace(/\.img$/, ".deleted")}`), false);

// A fresh module runtime must recover the deletion without its old in-memory row or image map.
memory.clear();
const oldRecord = row("reloaded-delete");
const oldImage = seedImage(oldRecord);
memory.set(`file:${oldImage.path.replace(/\.img$/, ".deleted")}`, "");
const reimportedImage = seedImage(oldRecord);
assert.notEqual(oldImage.path, reimportedImage.path);
const pendingDeadline = 20_000;
const oldPending = `${oldImage.path}.pending-${NOW - pendingDeadline - 1}-abandoned`;
const inFlightPending = `${reimportedImage.path}.pending-${NOW - pendingDeadline + 1}-active`;
const boundaryPending = `${reimportedImage.path}.pending-${NOW - pendingDeadline}-deadline`;
const futurePending = `${reimportedImage.path}.pending-${NOW + 1}-future`;
const unknownFile = `${oldImage.path}.pending-unknown`;
for (const path of [oldPending, inFlightPending, boundaryPending, futurePending, unknownFile]) memory.set(`file:${path}`, "synthetic pending bytes");
const cacheSource = readFileSync(new URL("../services/product-image-cache.ts", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "").replace(/^export /gm, "");
const replay = runInNewContext(`${stripTypeScriptTypes(cacheSource, { mode: "transform" })}\npruneProductImages;`, {
  Map, Set, Date, Math, FileManager,
  Path: { join: (...parts: string[]) => parts.join("/") },
  Crypto, utf8Data: (value: string) => value, writeDiagnostic: () => {},
});
replay([], [oldRecord.identity], NOW);
assert.equal(memory.has(`file:${oldImage.path}`), false,
  "a new runtime replays durable deletion markers even when previous rows contain no deleted identity");
assert.ok(memory.has(`file:${reimportedImage.path}`), "an old marker cannot delete a re-imported record's new immutable image");
assert.equal(memory.has(`file:${oldImage.path.replace(/\.img$/, ".deleted")}`), false);
assert.equal(memory.has(`file:${oldPending}`), false, "a fresh runtime removes only abandoned writes older than the shared write deadline");
for (const path of [inFlightPending, boundaryPending, futurePending, unknownFile]) {
  assert.ok(memory.has(`file:${path}`), "an active, future, deadline-boundary or unknown file is preserved");
}

memory.clear();
saveState(emptyState(), NOW);
memory.set(`file:${oldPending}`, "synthetic failed cleanup");
try {
  FileManager.removeSync = (path: string) => {
    if (path === oldPending) throw new Error("synthetic pending cleanup denied");
    originalRemove(path);
  };
  assert.doesNotThrow(() => loadState(NOW));
  assert.ok(memory.has(`file:${oldPending}`));
} finally { FileManager.removeSync = originalRemove; }
saveState(loadState(NOW), NOW + 1);
assert.equal(memory.has(`file:${oldPending}`), false, "a future load/save retries failed orphan cleanup without needing its deleted row");

console.log("product image lifecycle: retention, deletion retry, re-import isolation and abandoned-write recovery passed");
