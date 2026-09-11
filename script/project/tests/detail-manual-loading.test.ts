import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Exercise the owning page's actual async closure without pretending to render the iOS host.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
function capture(pattern: RegExp): string {
  const match = page.match(pattern);
  assert.ok(match, `Page seam is missing: ${pattern}`);
  return match[1]!;
}
const initialLoading = capture(/const \[loadingManualDetail, setLoadingManualDetail\] = useState\(\s*([\s\S]*?),\s*\);/);
const statusExpression = capture(/const statusText = ([\s\S]*?);/);
const emptyExpression = capture(/\{(loadingManualDetail \? MANUAL_QUERY_IN_FLIGHT_TEXT : "暂无物流轨迹")\}/);
const pendingText = capture(/const MANUAL_QUERY_IN_FLIGHT_TEXT = "([^"]+)"/);
const refreshStart = page.indexOf("  function refresh(forceManualRefresh");
const refreshEnd = page.indexOf("  async function copyWaybill()", refreshStart);
assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
const refreshSource = stripTypeScriptTypes(page.slice(refreshStart, refreshEnd));
const cleanup = capture(/return \(\) => \{\s*(refreshGenerationRef\.current \+= 1;[\s\S]*?)\s*\};\s*\}, \[props\.shipment\.identity\.id\]\);/);

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function shipment(semantic = "UNKNOWN", tracks: any[] = []) {
  return { identity: { id: "manual:synthetic" }, timeline: { semantic, tracks } };
}
function pageHarness(seed = shipment()) {
  const network = deferred();
  const state = { loading: false, shipment: seed, notices: [] as string[], updates: 0, calls: 0 };
  let signal: AbortSignal | undefined;
  let onPreview: ((value: any) => void) | undefined;
  const context: any = {
    props: {
      shipment: seed,
      refreshOnAppear: "manual_submit",
      manualPreview: { shipment: seed, roundComplete: false },
      onStateChange: () => { state.updates++; },
    },
    AbortController,
    refreshGenerationRef: { current: 0 },
    refreshInFlightRef: { current: null },
    refreshAbortRef: { current: null },
    pullInFlightRef: { current: null },
    detailEntryRef: { current: undefined },
    displayTracks: seed.timeline.tracks,
    setNotice: (text: string) => { state.notices.push(text); },
    setLoadingManualDetail: (value: boolean) => { state.loading = value; },
    setShipment: (update: (value: any) => any) => { state.shipment = update(state.shipment); },
    preferNewerShipment: (_old: any, next: any) => next,
    continueManualShipmentPreview: (_preview: any, options: any) => {
      state.calls++;
      signal = options.signal;
      onPreview = options.onPreview;
      return network.promise;
    },
    refreshShipmentById: () => { throw new Error("Initial preview must use continuation"); },
    selectShipmentDetailTimeline: (value: any) => value.timeline,
    manualPreviewNeedsDetailRefresh: (value: any) => value.timeline.complete !== true,
    isProviderErrorDetail: () => false,
    manualDetailRefreshToast: (refreshed: boolean, usable: boolean) => refreshed && usable ? "success" : "empty",
    detailPullToast: () => "pull",
    EXPRESS_TOAST_COPY: { detailRefreshFailed: "failed" },
    diagnosticErrorDetails: () => ({ errorCategory: "unexpected" }),
    writeDiagnostic: () => {},
  };
  state.loading = runInNewContext(initialLoading, context);
  const refresh = runInNewContext(`${refreshSource}\nrefresh;`, context);
  const labels = () => {
    const expressions = {
      loadingManualDetail: state.loading,
      presentationStatus: {
        semantic: state.shipment.timeline.semantic,
        text: state.shipment.timeline.semantic === "UNKNOWN" ? "暂无状态" : "运输中",
      },
      MANUAL_QUERY_IN_FLIGHT_TEXT: pendingText,
    };
    return {
      status: runInNewContext(statusExpression, expressions),
      empty: state.shipment.timeline.tracks.length ? null : runInNewContext(emptyExpression, expressions),
    };
  };
  return { state, network, refresh, labels,
    context,
    preview: (value: any) => onPreview?.(value),
    unmount: () => runInNewContext(cleanup, context),
    aborted: () => signal?.aborted,
  };
}

// Opening and pulling are different operations, but repeated pulls share the same continuation.
for (const entryFails of [false, true]) {
  const page = pageHarness(shipment("TRANSIT", [{ detail: "Cached event" }]));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  const calls: any[] = [];
  const entry = deferred();
  const pull = deferred();
  page.context.refreshShipmentById = (_id: string, options: any) => {
    calls.push(options);
    return options.trigger === "detail_open" ? entry.promise : pull.promise;
  };
  const opening = page.refresh(false);
  const pulling = page.refresh(true);
  assert.equal(page.refresh(true), pulling);
  assert.equal(calls.length, 1);
  const observation = { fingerprint: "same-request", gaveTimeline: !entryFails };
  entry.resolve({ shipment: page.state.shipment, state: {}, refreshed: false,
    querySucceeded: !entryFails, detailEntry: observation });
  await opening;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].trigger, "detail_pull");
  assert.equal(calls[1].detailEntry, observation, "failed entry outcomes travel to pull too");
  assert.equal(page.refresh(true), page.context.pullInFlightRef.current);
  pull.resolve({ shipment: page.state.shipment, state: {}, refreshed: false, querySucceeded: false });
  await pulling;
  assert.equal(page.state.notices.at(-1), "failed", "cached content does not turn failure into up-to-date");
}

// A primary provider may finish while its peer is still pending after an empty Picker.
{
  const page = pageHarness();
  const pending = page.refresh();
  page.preview(shipment("TRANSIT", [{ detail: "First usable provider result" }]));
  assert.deepEqual(page.labels(), { status: "运输中", empty: null });
  assert.equal(page.state.loading, true);
  assert.equal(page.state.updates, 0, "preview is local to this detail page");
  const full = shipment("TRANSIT", [{ detail: "Full history" }]);
  (full.timeline as any).complete = true;
  page.preview(full);
  assert.equal(page.state.loading, false, "a complete preview no longer needs a loading footer");
  page.network.resolve({ shipment: full, state: {}, refreshed: true });
  await pending;
  assert.equal(page.state.updates, 1);
}

// The logged Picker-empty interval starts on the very first render, before any effect runs.
{
  const page = pageHarness();
  assert.deepEqual(page.labels(), { status: "查询中", empty: "查询中" });
  const first = page.refresh();
  assert.equal(page.refresh(), first, "a repeated refresh joins the existing round");
  assert.equal(page.state.calls, 1);
  assert.deepEqual(page.labels(), { status: "查询中", empty: "查询中" });
  page.network.resolve({ shipment: shipment("TRANSIT", [{ detail: "快件运输中" }]), state: {}, refreshed: true });
  await first;
  assert.deepEqual(page.labels(), { status: "运输中", empty: null });
  assert.equal(page.state.loading, false);
  assert.equal(page.state.updates, 1);
}

// A partial Picker result stays visible while enrichment is pending.
{
  const page = pageHarness(shipment("TRANSIT", [{ detail: "快件运输中" }]));
  const pending = page.refresh();
  assert.deepEqual(page.labels(), { status: "运输中", empty: null });
  page.network.resolve({ shipment: shipment("TRANSIT", [{ detail: "节点一" }, { detail: "节点二" }]), state: {}, refreshed: true });
  await pending;
  assert.equal(page.state.shipment.timeline.tracks.length, 2);
  assert.equal(page.state.loading, false);
}

for (const fails of [false, true]) {
  const page = pageHarness();
  const pending = page.refresh();
  if (fails) page.network.reject(new Error("synthetic failure"));
  else page.network.resolve({ shipment: shipment(), state: {}, refreshed: false });
  await pending;
  assert.equal(page.state.loading, false);
  assert.deepEqual(page.labels(), { status: "暂无状态", empty: "暂无物流轨迹" });
  assert.equal(page.state.notices.at(-1), fails ? "failed" : "empty");
}

// Leaving the page aborts the round and fences every late UI write, including loading cleanup.
{
  const page = pageHarness();
  const pending = page.refresh();
  const notices = page.state.notices.length;
  page.unmount();
  assert.equal(page.aborted(), true);
  page.preview(shipment("TRANSIT", [{ detail: "Late preview" }]));
  assert.equal(page.state.shipment.timeline.semantic, "UNKNOWN");
  page.network.resolve({ shipment: shipment("TRANSIT", [{ detail: "late" }]), state: {}, refreshed: true });
  await pending;
  assert.equal(page.state.updates, 0);
  assert.equal(page.state.notices.length, notices);
  assert.equal(page.state.shipment.timeline.semantic, "UNKNOWN");
  assert.equal(page.state.loading, true, "unmounted state must not be updated by finally");
}

console.log("manual detail loading lifecycle tests passed");
