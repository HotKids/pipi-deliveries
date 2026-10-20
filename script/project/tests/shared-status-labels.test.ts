import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NormalizedStatus, Shipment, StatusSemantic, TimelinePackage } from "../models";
import {
  BOOTSTRAP_STATUS_LABEL_TABLE,
  activeStatusLabelTable,
  installStatusLabelTable,
  parseStatusLabelTable,
  resetStatusLabelTableForTesting,
  statusDisplay,
} from "../services/status-labels";
import {
  buildWidgetSnapshot,
  shipmentDetailPresentationStatus,
  shipmentPresentationStatus,
} from "../services/status";
import { parseCarrierAuthorityPayload } from "../services/carrier-authority";

// Audits L5 and L1 (user defaults 2026-09-25): one status label table, served by the Worker as
// `statusLabels` and bundled as the bootstrap, and one display function for the list, detail, widgets
// and notification titles. DANGER reads 异常件 and UNKNOWN 暂无状态; an order row without a real waybill
// shows PICKED and SHIPPED as 已下单. Expected values come from the Worker-generated shared fixture.
const shared = JSON.parse(readFileSync(
  new URL("./fixtures/express/status-labels.v1.json", import.meta.url), "utf8"));
const NOW = Date.UTC(2026, 8, 25, 0, 0, 0);

assert.deepEqual(JSON.parse(JSON.stringify(BOOTSTRAP_STATUS_LABEL_TABLE)), shared.table,
  "the bundled table equals the Worker's");
assert.deepEqual(parseStatusLabelTable(shared.table), BOOTSTRAP_STATUS_LABEL_TABLE);

function timeline(semantic: StatusSemantic, normalizedStatus?: NormalizedStatus): TimelinePackage {
  return {
    provider: "interface5", waybill: "3610000000000123", courierCode: "", companyName: "京东购物",
    semantic, structuredStatus: Boolean(normalizedStatus?.structured), statusEventAtMs: normalizedStatus?.eventAtMs || null,
    ...(normalizedStatus ? { normalizedStatus } : {}),
    latestTimeText: "2026-09-24 10:00:00", latestDetail: "节点", tracks: [], successAtMs: NOW,
  };
}

function row(scope: "ORDER" | "SHIPMENT", semantic: StatusSemantic, projection?: NormalizedStatus,
  presentation?: Shipment["statusPresentation"]): Shipment {
  const order = scope === "ORDER";
  const packet = timeline(semantic, projection);
  return {
    identity: { id: `interface5:account:${order ? "3610000000000123" : "YT0000000000123"}`,
      bindingSource: "interface5", sourceOwner: order ? "interface5:order" : "interface5",
      sourceId: order ? "3610000000000123" : "YT0000000000123", orderId: order ? "3610000000000123" : "",
      projectedWaybill: "", accountOrder: order, manuallyAdded: false, sourceProvider: order ? "JingDong" : "CaiNiao",
      courierCode: "", companyName: order ? "京东购物" : "圆通速递", phone: "13800000123", phoneTail: "0123",
      createdAtMs: NOW },
    timeline: packet, sourceTimeline: packet, manualTimelines: [], route: null, accountRecord: null,
    ...(presentation ? { statusPresentation: presentation } : {}), updatedAtMs: NOW,
  };
}

// Presentation normalizes cancellation without rewriting an older authority table or timeline.
{
  const remote = parseStatusLabelTable({
    ...BOOTSTRAP_STATUS_LABEL_TABLE,
    orderLabels: { ...BOOTSTRAP_STATUS_LABEL_TABLE.orderLabels, CANCELLED: "订单已取消" },
  })!;
  assert.ok(remote);
  assert.equal(installStatusLabelTable(remote), true);
  assert.equal(activeStatusLabelTable().orderLabels.CANCELLED, "订单已取消");
  assert.deepEqual(statusDisplay({ scope: "ORDER", semantic: "CANCELLED" }),
    { semantic: "CANCELLED", label: "已取消" }, "an older remote order label is display-only normalized");
  assert.deepEqual(statusDisplay({ scope: "ORDER", semantic: "COMPLETED" }),
    { semantic: "COMPLETED", label: "已完成" }, "order completion retains its distinct label");
  assert.deepEqual(statusDisplay({ scope: "SHIPMENT", semantic: "CANCELLED" }),
    { semantic: "CANCELLED", label: "已取消" });

  const cancelled = row("ORDER", "CANCELLED", {
    version: 1, scope: "ORDER", semantic: "CANCELLED", code: "", text: "订单已取消",
    priority: 0, eventAtMs: NOW, structured: true,
  });
  cancelled.timeline.latestDetail = "订单已取消";
  cancelled.timeline.latestTimeText = new Date(NOW).toISOString();
  cancelled.timeline.tracks = [{
    timeText: cancelled.timeline.latestTimeText, timeMs: NOW, detail: "订单已取消", statusCode: "", raw: {},
  }];
  const original = JSON.stringify(cancelled);
  assert.deepEqual(shipmentPresentationStatus(cancelled), { semantic: "CANCELLED", text: "已取消" });
  assert.deepEqual(shipmentDetailPresentationStatus(cancelled, cancelled.timeline),
    { semantic: "CANCELLED", text: "已取消" });
  const widget = buildWidgetSnapshot([cancelled], NOW);
  assert.equal(widget.rows[0].statusLabel, "已取消");
  assert.equal(widget.headline, null, "cancellation keeps the existing widget summary priority");
  assert.equal(JSON.stringify(cancelled), original, "presentation preserves raw Worker and timeline text");
  assert.equal(activeStatusLabelTable().orderLabels.CANCELLED, "订单已取消");
  resetStatusLabelTableForTesting();
}

for (const item of shared.cases) {
  const label = `${item.scope} ${item.semantic} ${item.code}`;
  const projection: NormalizedStatus = { version: 1, scope: item.scope, semantic: item.semantic, code: item.code,
    text: item.workerText, priority: item.workerPriority, eventAtMs: item.semantic === "UNKNOWN" ? 0 : NOW,
    structured: item.semantic !== "UNKNOWN" };
  const current = row(item.scope, item.semantic, projection);
  assert.deepEqual(shipmentPresentationStatus(current), { semantic: item.display.semantic, text: item.display.label },
    `${label}: row carrying the Worker projection`);
  // A Worker that still sends its older DANGER text (运输异常) shows the same table label. A Worker
  // UNKNOWN keeps the Worker's own text (older Workers send none): default #2's 暂无状态 conflicts with
  // the user's 2026-09-09 rule that the Home list never shows 暂无状态, and is left for the user.
  if (item.semantic === "UNKNOWN") {
    assert.equal(shipmentPresentationStatus(row(item.scope, item.semantic, { ...projection, text: "" })).text, "",
      `${label}: pending the user's decision, unchanged`);
  } else {
    const olderText = { ...projection, text: item.semantic === "DANGER" ? "运输异常" : projection.text };
    assert.equal(shipmentPresentationStatus(row(item.scope, item.semantic, olderText)).text, item.display.label,
      `${label}: older Worker text`);
  }
  // Rows stored before the Worker projection existed read the same table.
  if (item.code) continue;
  const legacy = item.scope === "ORDER"
    ? row("ORDER", item.semantic === "PICKED" || item.semantic === "SHIPPED" ? "ORDERED" : item.semantic, undefined,
        item.semantic === "COMPLETED" || item.semantic === "CANCELLED" ? undefined
          : { scope: "ORDER", semantic: item.semantic, text: item.workerText || "x" })
    : row("SHIPMENT", item.semantic);
  if (item.scope === "ORDER" && item.semantic === "UNKNOWN") continue;
  assert.deepEqual(shipmentPresentationStatus(legacy), { semantic: item.display.semantic, text: item.display.label },
    `${label}: stored row without a projection`);
}

// The widget and the notification title read the same presentation.
{
  const danger = row("SHIPMENT", "DANGER");
  assert.equal(buildWidgetSnapshot([danger], NOW).rows[0].statusLabel, "异常件");
  const shipped = row("ORDER", "SHIPPED", { version: 1, scope: "ORDER", semantic: "SHIPPED", code: "", text: "已发货",
    priority: 0, eventAtMs: NOW, structured: true });
  assert.equal(buildWidgetSnapshot([shipped], NOW).rows[0].statusLabel, "已下单");
  assert.equal(buildWidgetSnapshot([shipped], NOW).rows[0].semantic, "ORDERED");
}

// The Worker snapshot's table replaces the bundled one; a malformed table rejects the snapshot.
{
  const validation = JSON.parse(readFileSync(
    new URL("./fixtures/express/carrier-table-validation.v1.json", import.meta.url), "utf8"));
  const served = { ...validation.base, statusLabels: shared.table };
  assert.deepEqual(parseCarrierAuthorityPayload(served)?.statusLabels, BOOTSTRAP_STATUS_LABEL_TABLE);
  assert.equal(parseCarrierAuthorityPayload({ ...validation.base })?.statusLabels, undefined,
    "an older Worker without the table keeps the one in use");
  for (const broken of [
    { ...shared.table, schemaVersion: 2 },
    { ...shared.table, labels: { ...shared.table.labels, DANGER: "" } },
    { ...shared.table, labels: { ...shared.table.labels, UNKNOWN: undefined } },
    { ...shared.table, subtypes: [{ semantic: "DELIVERY", code: "", label: "x", priority: 1 }] },
    { ...shared.table, unprojectedOrder: { scope: "ORDER", displaySemantic: { PICKED: "SOMETHING" } } },
  ]) {
    assert.equal(parseCarrierAuthorityPayload({ ...validation.base, statusLabels: broken }), null);
  }
  const renamed = parseStatusLabelTable({ ...shared.table, labels: { ...shared.table.labels, DANGER: "问题件" } })!;
  assert.equal(installStatusLabelTable(renamed), true);
  assert.equal(activeStatusLabelTable().labels.DANGER, "问题件");
  assert.equal(shipmentPresentationStatus(row("SHIPMENT", "DANGER")).text, "问题件",
    "the installed Worker table is what every surface shows");
  resetStatusLabelTableForTesting();
  assert.equal(shipmentPresentationStatus(row("SHIPMENT", "DANGER")).text, "异常件");
}

console.log("shared status label tests passed");
