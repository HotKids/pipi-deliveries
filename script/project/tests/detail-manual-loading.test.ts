import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { jdRiskControlRetryText } from "../services/express-toast-copy";

// Exercise the owning page's actual async closure without pretending to render the iOS host.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
function capture(pattern: RegExp): string {
  const match = page.match(pattern);
  assert.ok(match, `Page seam is missing: ${pattern}`);
  return match[1]!;
}
const initialLoading = capture(/const \[loadingManualDetail, setLoadingManualDetail\] = useState\(\s*([\s\S]*?),\s*\);/);
const statusExpression = capture(/const statusText = ([\s\S]*?);/);
const emptyExpression = capture(/\{(loadingManualDetail \? MANUAL_QUERY_IN_FLIGHT_TEXT : "暂无物流信息")\}/);
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
    joinedJdPullRef: { current: false },
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
    hasActiveAccountOrderProjection: () => false,
    isJingDongSourceShipment: () => false,
    unprojectedAccountOrder: () => false,
    selectShipmentDetailTimeline: (value: any) => value.timeline,
    manualPreviewNeedsDetailRefresh: (value: any) => value.timeline.complete !== true,
    isProviderErrorDetail: () => false,
    manualDetailRefreshToast: (refreshed: boolean, usable: boolean) => refreshed && usable ? "success" : "empty",
    detailPullToast: () => "pull",
    jdRiskControlRetryText,
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
  const noticesBeforePull = page.state.notices.filter(Boolean).length;
  pull.resolve({ shipment: page.state.shipment, state: {}, refreshed: false, querySucceeded: false });
  await pulling;
  // User default #10 / audit R3 (2026-09-25): with a cached timeline on screen a failed pull is
  // silent — neither 「轨迹更新失败」 nor a misleading 「当前轨迹已是最新」.
  assert.equal(page.state.notices.filter(Boolean).length, noticesBeforePull,
    "a failed pull over cached content is silent");
}

// A pull during actual JD capture reuses it, including failure, without queuing a second load.
for (const captureStarted of [false, true]) {
  const page = pageHarness(shipment("TRANSIT", [{ detail: "Cached JD event" }]));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  page.context.hasActiveAccountOrderProjection = () => captureStarted;
  page.context.isJingDongSourceShipment = () => true;
  page.context.unprojectedAccountOrder = () => !captureStarted;
  const capture = deferred();
  let calls = 0;
  page.context.refreshShipmentById = () => { calls++; return capture.promise; };
  const opening = page.refresh(false);
  assert.equal(page.refresh(true), opening);
  assert.equal(page.refresh(true), opening);
  if (captureStarted) capture.reject(new Error("JD capture timeout"));
  else capture.resolve({ shipment: page.state.shipment, state: {}, refreshed: false, querySucceeded: false });
  await opening;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "a joined gesture never adds a capture when the first one ends");
}

// A pull joining the page's entry still receives fresh or persisted risk-control remaining time.
for (const freshRisk of [true, false]) {
  const page = pageHarness(shipment("TRANSIT", [{ detail: "Cached JD event" }]));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  page.context.hasActiveAccountOrderProjection = () => true;
  const capture = deferred();
  page.context.refreshShipmentById = () => capture.promise;
  const opening = page.refresh(false);
  assert.equal(page.refresh(true), opening);
  capture.resolve({ shipment: page.state.shipment, state: {}, refreshed: false, querySucceeded: false,
    ...(freshRisk ? { expressToast: "jdRiskControl" } : {}), expressToastRemainingMs: 60_001 });
  await opening;
  assert.equal(page.state.notices.at(-1), "京东风控中，请在 2 分钟后重试");
}

// A pull that throws is silent over cached content too, and reports the failure without it.
for (const [tracks, expected] of [[[{ detail: "Cached event" }], 0], [[], 1]] as const) {
  const page = pageHarness(shipment("TRANSIT", [...tracks]));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  page.context.refreshShipmentById = async () => { throw new Error("synthetic pull failure"); };
  const shown = () => page.state.notices.filter(Boolean).length; // setNotice("") only clears the toast
  const before = shown();
  await page.refresh(true);
  assert.equal(shown() - before, expected,
    `thrown pull with ${tracks.length} cached tracks: ${JSON.stringify(page.state.notices)}`);
}

// A blocked pull reports the remaining risk-control time even while cached history is visible.
{
  assert.equal(jdRiskControlRetryText(60_001), "京东风控中，请在 2 分钟后重试");
  assert.equal(jdRiskControlRetryText(1), "京东风控中，请在 1 分钟后重试");
  const page = pageHarness(shipment("TRANSIT", [{ detail: "Cached JD event" }]));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  page.context.refreshShipmentById = async () => ({ shipment: page.state.shipment, state: {},
    refreshed: false, querySucceeded: false, expressToast: "jdRiskControl", expressToastRemainingMs: 60_001 });
  await page.refresh(true);
  assert.equal(page.state.notices.at(-1), "京东风控中，请在 2 分钟后重试");
}

// Without any timeline to show, a failed pull still reports the failure.
{
  const page = pageHarness(shipment("TRANSIT", []));
  page.context.props.refreshOnAppear = "detail_open";
  page.context.props.manualPreview = null;
  page.context.refreshShipmentById = async () =>
    ({ shipment: page.state.shipment, state: {}, refreshed: false, querySucceeded: false });
  await page.refresh(true);
  assert.equal(page.state.notices.at(-1), "failed", "no cached content: the failure is reported");
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
  assert.deepEqual(page.labels(), { status: "暂无状态", empty: "暂无物流信息" });
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
