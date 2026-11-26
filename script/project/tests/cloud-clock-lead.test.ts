import assert from "node:assert/strict";
import "./state-storage-mock";
import { parseCloudParcelDetails } from "../services/cloud-parcel-metadata";

// R5-NEW-11 ④ (fifth review, 2026-11-25): parcel metadata the Worker just wrote may lead a slow iPhone clock by up to
// the Worker's five-minute tolerance, as the PDD pages already allow (R4-NEW-06). Identities are synthetic.
const NOW = Date.UTC(2026, 8, 8, 6, 0, 0);
const waybill = "YT000000011041";
const ahead = NOW + 90_000;

const fresh = parseCloudParcelDetails({ ok: true, metadata: { waybill, anchorAt: ahead, terminalAt: 0,
  productName: "Synthetic item", deliveryEstimate: "预计9月10日送达", deliveryEstimateObservedAt: ahead } }, waybill, NOW);
assert.equal(fresh?.metadata?.productName, "Synthetic item", "a just-written product name is kept");
assert.equal(fresh?.metadata?.anchorAt, NOW, "its anchor reads as now");
assert.equal(fresh?.metadata?.deliveryEstimate, "预计9月10日送达");
assert.equal(fresh?.metadata?.deliveryEstimateObservedAt, NOW, "and its estimate keeps its observation time");

const signed = parseCloudParcelDetails({ ok: true, metadata: { waybill, anchorAt: NOW - 3_600_000, terminalAt: ahead,
  productName: "Synthetic item" } }, waybill, NOW);
assert.equal(signed?.metadata?.terminalAt, NOW, "a just-signed parcel keeps its terminal time");
assert.equal(signed?.metadata?.productName, "Synthetic item", "and its metadata is not emptied");

const link = parseCloudParcelDetails({ ok: true, metadata: null, pddLink: { waybill, anchorAt: ahead, terminalAt: 0,
  shippingId: "73001041", observedAt: ahead } }, waybill, NOW);
assert.equal(link?.pddLink?.shippingId, "73001041", "a just-written PDD link is kept");

// Beyond the tolerance a time is still invalid, as before.
const far = NOW + 6 * 60_000;
assert.equal(parseCloudParcelDetails({ ok: true, metadata: { waybill, anchorAt: far, productName: "Synthetic item" } },
  waybill, NOW), undefined, "an anchor further ahead is rejected");
assert.equal(parseCloudParcelDetails({ ok: true, metadata: { waybill, anchorAt: NOW - 3_600_000, terminalAt: far,
  productName: "Synthetic item" } }, waybill, NOW), undefined, "a terminal time further ahead is rejected");
assert.equal(parseCloudParcelDetails({ ok: true, metadata: { waybill, anchorAt: NOW - 3_600_000,
  deliveryEstimate: "预计9月10日送达", deliveryEstimateObservedAt: far } }, waybill, NOW), undefined,
  "an estimate observed further ahead is not a field");

console.log("cloud parcel metadata reads a leading cloud clock within the tolerance");
