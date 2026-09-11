import assert from "node:assert/strict";
import { test } from "node:test";
import { RefreshCoordinator } from "../services/refresh-coordination";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
test("foreground detail proceeds while unrelated full refresh remains pending", async () => {
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const gate = deferred<string>();
  const full = coordinator.runFull("v5", () => gate.promise);
  const result = await coordinator.runIndependentDetail("parcel:v5:detail", "v5", async () => "detail", Date.now() + 1000);
  assert.equal(result, "detail");
  assert.ok(coordinator.full("v5"));
  gate.resolve("list");
  await full;
});
test("equivalent consumers share work; leaving one page cannot cancel another owner", async () => {
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const gate = deferred<string>();
  let calls = 0;
  let providerSignal!: AbortSignal;
  const task = (signal: AbortSignal) => { calls++; providerSignal = signal; return gate.promise; };
  const page = new AbortController();
  const first = coordinator.runIndependentDetail("same:params:mode:owner", "v5", task, Date.now() + 1000, page.signal);
  const second = coordinator.runIndependentDetail("same:params:mode:owner", "v5", task, Date.now() + 1000);
  await Promise.resolve();
  assert.equal(calls, 1);
  const rejection = assert.rejects(first);
  page.abort(); await rejection;
  assert.equal(providerSignal.aborted, false);
  gate.resolve("result"); assert.equal(await second, "result");
});
test("changed parameters do not coalesce and queued Online work waits for foreground", async () => {
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const gate = deferred<string>();
  let calls = 0;
  const task = () => { calls++; return gate.promise; };
  const first = coordinator.runIndependentDetail("parcel:old-owner", "v5", task, Date.now() + 1000);
  const second = coordinator.runIndependentDetail("parcel:new-owner", "v5", task, Date.now() + 1000);
  let admitted = false;
  const queue = coordinator.waitForForeground("v5", Date.now() + 1000).then(() => { admitted = true; });
  await Promise.resolve();
  assert.equal(calls, 2); assert.equal(admitted, false);
  gate.resolve("done"); await Promise.all([first, second, queue]);
  assert.equal(admitted, true);
});
test("last owner cancellation releases queued work even when the provider ignores abort", async () => {
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const page = new AbortController();
  const pending = coordinator.runIndependentDetail("parcel", "v5", () => new Promise(() => {}), Date.now() + 1000, page.signal);
  const rejection = assert.rejects(pending);
  const queue = coordinator.waitForForeground("v5", Date.now() + 1000);
  page.abort(); await rejection; await queue;
});
