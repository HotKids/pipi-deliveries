import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppState } from "../models";
import {
  reloadAndRefreshOnResume,
  resumeShipmentId,
} from "../services/app-resume";

function state(revision: number): AppState {
  return {
    version: 2,
    revision,
    updatedAtMs: revision,
    activeSource: "interface5",
    bindings: [],
    pendingQueries: [],
    shipments: [],
  };
}

assert.equal(
  resumeShipmentId({
    queryParameters: { shipment: " query-shipment " },
    notificationInfo: {
      request: { content: { userInfo: { shipment: "notification-shipment" } } },
    },
  }),
  "query-shipment",
  "query parameters must take precedence over notification metadata",
);
assert.equal(
  resumeShipmentId({
    notificationInfo: {
      request: { content: { userInfo: { shipment: "notification-shipment" } } },
    },
  }),
  "notification-shipment",
);
assert.equal(
  resumeShipmentId({
    queryParameters: { shipment: 123 },
    notificationInfo: {
      request: { content: { userInfo: { shipment: { unsafe: true } } } },
    },
  }),
  "",
  "non-string external values must not become navigation targets",
);

const persisted = state(2);
const refreshed = state(3);
const events: string[] = [];
await reloadAndRefreshOnResume(
  {
    notificationInfo: {
      request: { content: { userInfo: { shipment: "shipment-1" } } },
    },
  },
  {
    load: () => {
      events.push("load");
      return persisted;
    },
    applyPersisted: (value, shipmentId) => {
      events.push(`apply:${value.revision}:${shipmentId}`);
    },
    refresh: async () => {
      events.push("refresh");
      return {
        attempted: 1,
        succeeded: 1,
        failed: 0,
        state: refreshed,
        promotedPendingShipmentIds: [],
      };
    },
    applyRefreshed: (value) => {
      events.push(`network:${value.revision}`);
    },
  },
);
assert.deepEqual(events, [
  "load",
  "apply:2:shipment-1",
  "refresh",
  "network:3",
]);

const failureEvents: string[] = [];
await reloadAndRefreshOnResume({}, {
  load: () => persisted,
  applyPersisted: () => failureEvents.push("persisted"),
  refresh: async () => {
    failureEvents.push("refresh");
    throw new Error("offline");
  },
  applyRefreshed: () => failureEvents.push("unexpected"),
});
assert.deepEqual(failureEvents, ["persisted", "refresh"]);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
const homeSource = await readFile(resolve(projectDir, "pages/HomePage.tsx"), "utf8");
assert.match(indexSource, /Script\.onResume\([\s\S]*?reloadAndRefreshOnResume/);
assert.match(
  indexSource,
  /notificationInfo:\s*Notification\.current/,
  "a notification body tap must restore its shipment on a cold start",
);
assert.match(
  indexSource,
  /applyPersisted:[\s\S]*?setStartup\(\{ state: persisted \}\)[\s\S]*?setNavigationRequest/,
);
assert.match(indexSource, /refresh: \(\) => refreshAllShipments\(\)/);
assert.match(
  homeSource,
  /navigationRequestGeneration[\s\S]*?setShipmentNavigationTarget\([\s\S]*?persistedShipmentNavigationTarget\(props\.initialShipmentId\)/,
);

console.log("app resume reload and navigation tests passed");
