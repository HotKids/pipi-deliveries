import assert from "node:assert/strict";
import { projectAccountOrder } from "../services/account-order-projection";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import type { AccountParcelDto } from "../services/account-parser";

const parcel = {
  ownerId: "1234567890123456",
  waybill: "1234567890123456",
  accountOrder: true,
  source: "interface5",
  courierCode: "JDKD",
  rawCourierCode: "JDKD",
  rawCompanyName: "京东购物",
  projectionUrl: "https://u.jd.com/viewport-fixture",
} as AccountParcelDto;
const identity = {
  waybillCode: "JD0001234567890",
  companyName: "京东物流",
  extractionSource: "probe",
};
const track = (time: string) => ({ time, desc: "快件运输中" });
let evaluations = 0;
let disposals = 0;
let hosted = false;
let requireHosted = false;
let captures: unknown[] = [];
class ProjectionWebView {
  async loadURL() {
    if (requireHosted) assert.equal(hosted, true, "mount must finish before navigation");
    return true;
  }
  async evaluateJavaScript() {
    const result = captures[Math.min(evaluations, captures.length - 1)];
    evaluations++;
    return result;
  }
  dispose() { disposals++; }
}
Object.assign(globalThis, { WebViewController: ProjectionWebView });

// A missing viewport cannot expand the modal. Identity must not wait for that proof,
// and the partial single response must never become a complete timeline.
for (const traceList of [[], [track("2026-09-13 12:00:00")]]) {
  evaluations = 0;
  disposals = 0;
  captures = [{ ...identity, traceList }];
  registerProjectionViewportHost(null);
  const result = await projectAccountOrder(parcel, Date.now() + 400);
  assert.equal(evaluations, 1, "headless identity must return on the first accepted capture");
  assert.equal(result.waybill, identity.waybillCode);
  assert.equal(result.rawCourierCode, "", "order carrier metadata must not survive identity projection");
  assert.notEqual(result.projectionTimeline?.complete, true);
  assert.equal(result.projectionTimeline?.tracks.length || 0, traceList.length);
  assert.equal(disposals, 1);
}

// With a viewport, the same initial partial capture must still wait for the next
// complete response. Only that response supplies the final package.
evaluations = 0;
disposals = 0;
requireHosted = true;
captures = [
  { ...identity, traceList: [track("2026-09-13 12:00:00")] },
  { ...identity, traceList: [track("2026-09-13 13:00:00"), track("2026-09-13 10:00:00")] },
];
registerProjectionViewportHost({
  mount: async () => { hosted = true; return true; },
  unmount: () => { hosted = false; },
});
const complete = await projectAccountOrder(parcel, Date.now() + 1_000);
assert.equal(evaluations, 2);
assert.equal(complete.projectionTimeline?.complete, true);
assert.equal(complete.projectionTimeline?.tracks.length, 2, "responses remain separate");
assert.equal(hosted, false);
assert.equal(disposals, 1);
registerProjectionViewportHost(null);

// Native mounting can stall or be interrupted before navigation. Neither case may
// leave the serialized capture queue waiting indefinitely or start a disposed view.
for (const cancel of [false, true]) {
  evaluations = 0;
  disposals = 0;
  let mountStarted!: () => void;
  const started = new Promise<void>((resolve) => { mountStarted = resolve; });
  let settleMount!: (mounted: boolean) => void;
  let releases = 0;
  registerProjectionViewportHost({
    mount: () => new Promise<boolean>((resolve) => {
      settleMount = resolve;
      mountStarted();
    }),
    unmount: () => { releases++; settleMount(false); },
  });
  const cancellation = new AbortController();
  const pending = projectAccountOrder(parcel, Date.now() + 30, undefined, cancellation.signal);
  await started;
  if (cancel) cancellation.abort();
  let watchdog: ReturnType<typeof setTimeout>;
  const outcome = await Promise.race([
    pending.then(() => "unexpected_success", (error) => error.name),
    new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("mount_stalled"), 150); }),
  ]);
  clearTimeout(watchdog!);
  assert.equal(outcome, "OperationTimeoutError", "mount must honor cancellation and the capture deadline");
  assert.equal(evaluations, 0);
  assert.equal(disposals, 1);
  assert.equal(releases, 1);
  registerProjectionViewportHost(null);
}

console.log("projection identity and viewport tests passed");
