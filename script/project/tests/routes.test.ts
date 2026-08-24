import assert from "node:assert/strict";

const ROUTES_KEY = "pipi_deliveries_routes_v1";
const ORDER_PROJECTION_REFS_KEY =
  "pipi_deliveries_order_projection_refs_v1";
const memory = new Map<string, string>();

Object.assign(globalThis, {
  Keychain: {
    get(key: string): string | null {
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): boolean {
      memory.set(key, value);
      return true;
    },
  },
});

const {
  commitShipmentRouteMutations,
  loadOrderProjectionReference,
  loadShipmentRoute,
  migrateLegacyShipmentRoutes,
  pruneOrderProjectionReferences,
  saveOrderProjectionReferences,
  saveShipmentRoute,
} = await import("../services/routes");

const NOW = Date.UTC(2026, 7, 26, 9, 0, 0);
const URL_A = "https://page.cainiao.com/detail?a=1";
const URL_B = "https://page.cainiao.com/detail?a=2";

memory.clear();
assert.throws(() =>
  commitShipmentRouteMutations(
    [{
      key: "shipment:new-owner",
      kind: "save",
      targetId: "new-owner",
      source: "interface6",
      url: URL_A,
    }],
    () => {
      throw new Error("state commit failed");
    },
    NOW,
  )
);
assert.throws(
  () => loadShipmentRoute("new-owner", "interface6", NOW),
  /当前快递服务不可用/,
);

memory.set(ROUTES_KEY, JSON.stringify({
  "legacy-owner": {
    url: URL_A,
    source: "interface6",
    updatedAtMs: NOW - 1,
  },
}));
migrateLegacyShipmentRoutes(
  [{ fromId: "legacy-owner", toId: "interface5:manual:LEGACY" }],
  NOW,
);
assert.equal(
  loadShipmentRoute("interface5:manual:LEGACY", "interface5", NOW),
  URL_A,
);

memory.clear();
assert.equal(saveShipmentRoute("pending-owner", "interface5", URL_A, NOW), true);
assert.throws(() =>
  commitShipmentRouteMutations(
    [{
      key: "shipment:promoted-owner",
      kind: "move",
      fromId: "pending-owner",
      targetId: "promoted-owner",
      source: "interface5",
    }],
    () => {
      throw new Error("state commit failed");
    },
    NOW,
  )
);
assert.equal(loadShipmentRoute("pending-owner", "interface5", NOW), URL_A);
assert.equal(loadShipmentRoute("promoted-owner", "interface5", NOW), "");

const committed = commitShipmentRouteMutations(
  [{
    key: "shipment:promoted-owner",
    kind: "move",
    fromId: "pending-owner",
    targetId: "promoted-owner",
    source: "interface5",
  }],
  (publications) => publications[0]?.targetId || "",
  NOW,
);
assert.equal(committed, "promoted-owner");
assert.equal(loadShipmentRoute("pending-owner", "interface5", NOW), "");
assert.equal(loadShipmentRoute("promoted-owner", "interface5", NOW), URL_A);

assert.throws(() =>
  commitShipmentRouteMutations(
    [{
      key: "shipment:promoted-owner",
      kind: "save",
      targetId: "promoted-owner",
      source: "interface5",
      url: URL_B,
    }],
    () => {
      throw new Error("state commit failed");
    },
    NOW + 1,
  )
);
assert.equal(loadShipmentRoute("promoted-owner", "interface5", NOW + 1), URL_A);
assert.ok(memory.has(ROUTES_KEY));

memory.clear();
const projectionOwner = "interface5:account:ORDER20260827001";
const projectionUrl = "https://h5.m.jd.com/order/detail?orderId=1";
assert.equal(
  saveOrderProjectionReferences(
    [{ ownerId: projectionOwner, source: "interface5", url: projectionUrl }],
    NOW,
  ),
  1,
);
assert.equal(
  loadOrderProjectionReference(projectionOwner, "interface5", NOW),
  projectionUrl,
);
assert.equal(
  loadOrderProjectionReference(
    projectionOwner,
    "interface5",
    NOW + 8 * 24 * 60 * 60 * 1000,
  ),
  "",
);

assert.equal(
  saveOrderProjectionReferences(
    [{
      ownerId: "untrusted-http",
      source: "interface5",
      url: "http://h5.m.jd.com/order/detail",
    }, {
      ownerId: "untrusted-suffix",
      source: "interface5",
      url: "https://jd.com.attacker.example/order/detail",
    }],
    NOW,
  ),
  0,
);
assert.equal(
  loadOrderProjectionReference("untrusted-http", "interface5", NOW),
  "",
);

memory.set(ORDER_PROJECTION_REFS_KEY, JSON.stringify({
  [projectionOwner]: {
    url: projectionUrl,
    source: "interface6",
    updatedAtMs: NOW,
  },
}));
assert.equal(
  loadOrderProjectionReference(projectionOwner, "interface5", NOW),
  "",
);

memory.clear();
saveOrderProjectionReferences(
  [{ ownerId: projectionOwner, source: "interface5", url: projectionUrl }],
  NOW,
);
pruneOrderProjectionReferences([], NOW + 1);
assert.equal(
  loadOrderProjectionReference(projectionOwner, "interface5", NOW + 1),
  "",
);

memory.set(ORDER_PROJECTION_REFS_KEY, "{malformed");
pruneOrderProjectionReferences([], NOW + 1);
assert.equal(memory.get(ORDER_PROJECTION_REFS_KEY), "{}");

memory.set(ORDER_PROJECTION_REFS_KEY, JSON.stringify({
  invalid: null,
  retained: {
    url: projectionUrl,
    source: "interface5",
    updatedAtMs: NOW,
  },
}));
pruneOrderProjectionReferences(
  [{ ownerId: "retained", source: "interface5" }],
  NOW + 1,
);
assert.deepEqual(
  JSON.parse(memory.get(ORDER_PROJECTION_REFS_KEY) || "{}"),
  {
    retained: {
      url: projectionUrl,
      source: "interface5",
      updatedAtMs: NOW,
    },
  },
);

console.log("route commit boundary tests passed");
