import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import "./state-storage-mock";
import type { Shipment } from "../models";
import { cloudParcelMetadataForCache, readCachedCloudParcelMetadata, recordCloudParcelMetadata, type CloudParcelDetails }
  from "../services/cloud-parcel-metadata";
import { gatewayCredentialForLocalCache, gatewayCredentialGeneration, saveGatewayToken } from "../services/credentials";
import { GatewayError } from "../services/gateway";
import { internationalShipment } from "../services/international-records";
import { displayedPlatformFields } from "../services/platform-parcel-merge";
import { displayWaybill, unprojectedAccountOrder } from "../services/shipment-policy";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { normalizeWaybill } from "../services/status";

const source = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

// Run the detail's real first-render selection and refresh without loading a native view.
const render = new Function("context", stripTypeScriptTypes(`
  const { shipment, readOwnerState, visibleShipments, readCloudParcelMetadata, useState, useMemo, Date,
    normalizeWaybill, displayWaybill, unprojectedAccountOrder, shipmentLifecycleKey,
    gatewayCredentialForLocalCache, gatewayCredentialGeneration, GatewayError,
    readCachedCloudParcelMetadata, recordCloudParcelMetadata, cloudParcelMetadataForCache, internationalShipment } = context;
  const SCRIPT_BUILD_TRACK = "formal", props = { persistedShipment: true, visibleShipments: visibleShipments() };
  const useRef = current => ({ current });
  const needsExtraFields = true, localPddAppURL = "", cloudAbortRef = context.cloudAbortRef;
  ${section("  const [cloud, setCloud]", "  const cloudAbortRef")}
  ${section("  const syncedInternational =", "  const hotline")}
  ${section("  const cloudWaybill =", "  const pddExternalAppURL")}
  ${section("  function ownsCloudWaybill(", "\n  useEffect(() => {\n    showShipment(props.shipment)")}
`) + "\nreturn { cloudDetails, refreshCloudMetadata, cloudParcel };"),
  now = Date.now(), waybill = "YT000000008123";

const shipment: Shipment = {
  identity: { id: "synthetic-parcel", sourceId: waybill, sourceOwner: "manual", bindingSource: null,
    phoneTail: "", courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: now - 60_000 },
  timeline: { provider: "picker", waybill, courierCode: "YTO", companyName: "圆通速递", semantic: "TRANSIT",
    statusEventAtMs: now - 10_000, latestTimeText: "", latestDetail: "", tracks: [], successAtMs: now - 10_000 },
  updatedAtMs: now - 10_000,
};
const original = { waybill, anchorAt: now - 60_000, productName: "Original title", deliveryEstimate: "预计明天送达",
  deliveryEstimateObservedAt: now - 10_000, productImageURL: "https://img.alicdn.com/imgextra/i1/test-product.jpg" };
const updated = { ...original, productName: "Updated title", deliveryEstimate: "预计后天送达" };
let clock = now;
let visible = [shipment];
let requests = 0;
let reply = async (): Promise<CloudParcelDetails | undefined> => ({ metadata: original });

function mount(row = shipment) {
  let cloud: unknown;
  const cloudAbortRef = { current: null };
  return () => render({ shipment: row, visibleShipments: () => visible, readOwnerState: () => ({}),
    readCloudParcelMetadata: () => { requests++; return reply(); },
    useState: () => [cloud, (value: unknown) => { cloud = value; }],
    useMemo: (read: () => unknown) => read(), cloudAbortRef, Date: { now: () => ++clock },
    normalizeWaybill, displayWaybill, unprojectedAccountOrder, shipmentLifecycleKey,
    gatewayCredentialForLocalCache, gatewayCredentialGeneration, GatewayError,
    readCachedCloudParcelMetadata, recordCloudParcelMetadata, cloudParcelMetadataForCache, internationalShipment });
}

saveGatewayToken("SyntheticKey_001");
const first = mount();
assert.equal(first().cloudDetails, undefined);
await first().refreshCloudMetadata();
assert.equal(first().cloudDetails.metadata.productName, original.productName);

const second = mount();
assert.equal(second().cloudDetails?.metadata.productName, original.productName,
  "reopening starts with the previous title before any query");
assert.equal(second().cloudDetails?.metadata.productImageURL, original.productImageURL,
  "reopening starts with the already verified same-parcel image URL");
assert.equal(requests, 1);
assert.equal(displayedPlatformFields(shipment, now, second().cloudDetails?.metadata).estimate, original.deliveryEstimate,
  "reopening shows the same parcel's last valid estimate before any query");
let finish!: (value: CloudParcelDetails) => void;
reply = () => new Promise(resolve => { finish = resolve; });
const refreshing = second().refreshCloudMetadata();
assert.equal(second().cloudDetails.metadata.productName, original.productName);
assert.equal(second().cloudDetails.metadata.deliveryEstimate, original.deliveryEstimate);
finish({ metadata: updated });
await refreshing;
assert.equal(second().cloudDetails.metadata.productName, updated.productName);
assert.equal(mount()().cloudDetails.metadata.productName, updated.productName);
assert.equal(displayedPlatformFields(shipment, now, mount()().cloudDetails.metadata).estimate, updated.deliveryEstimate);

reply = async () => { throw new GatewayError("offline"); };
await second().refreshCloudMetadata();
assert.equal(second().cloudDetails.metadata.productName, updated.productName);
assert.equal(second().cloudDetails.metadata.productImageURL, original.productImageURL);
assert.equal(second().cloudDetails.metadata.deliveryEstimate, updated.deliveryEstimate);
assert.equal(displayedPlatformFields(shipment, now + 4 * 86_400_000, mount()().cloudDetails.metadata).estimate, "",
  "cached forecasts still expire based on their original observation clock");
const reused = { ...shipment, waybillReuseAtMs: now };
visible = [reused];
assert.equal(mount(reused)().cloudDetails, undefined, "a reused waybill has another cache identity");
assert.equal(mount()().cloudDetails, undefined, "the former lifecycle can no longer display its cached title");
visible = [shipment, { ...shipment, identity: { ...shipment.identity, id: "synthetic-duplicate" } }];
assert.equal(mount()().cloudDetails, undefined, "an ambiguous owner cannot display its cached title");
visible = [shipment];

reply = async () => undefined;
await second().refreshCloudMetadata();
assert.equal(second().cloudDetails, undefined, "a successful removal clears the old title in the current view");
assert.equal(mount()().cloudDetails, undefined);

reply = async () => ({ metadata: updated });
await second().refreshCloudMetadata();
const olderRequest = clock;
reply = async () => { throw new GatewayError("denied", 403, "cloud_sync_disabled"); };
await second().refreshCloudMetadata();
assert.equal(mount()().cloudDetails, undefined, "cloud access denial clears titles for the credential");
const oldScope = gatewayCredentialForLocalCache()!.scope;
recordCloudParcelMetadata(oldScope, second().cloudParcel, olderRequest, cloudParcelMetadataForCache(shipment, updated), () => true);
assert.equal(mount()().cloudDetails, undefined, "a reply started before denial cannot restore the cache");

reply = async () => ({ metadata: updated });
await second().refreshCloudMetadata();
assert.equal(mount()().cloudDetails.metadata.productName, updated.productName);
saveGatewayToken("SyntheticKey_002");
assert.equal(mount()().cloudDetails, undefined, "another credential cannot display the previous title");
console.log("cloud parcel title: cached first render, background update, transient failure and owner fences passed");
