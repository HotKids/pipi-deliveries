import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { runH5CaptureForTesting } from "../services/sync";

memory.clear();
let release!: () => void, active = 0, peak = 0;
const gate = new Promise<void>(resolve => { release = resolve; });
const first = runH5CaptureForTesting(async () => {
  active++; peak = Math.max(peak, active); await gate; active--; return "first";
}, Date.now() + 3000);
await new Promise(resolve => setImmediate(resolve));
const abort = new AbortController();
const second = runH5CaptureForTesting(async () => { assert.fail("cancelled queued capture must never create a controller"); }, Date.now() + 3000, abort.signal);
const rejection = assert.rejects(second, error => (error as Error).name === "OperationTimeoutError");
abort.abort(); await rejection;
let thirdStarted = false;
const third = runH5CaptureForTesting(async () => {
  thirdStarted = true; active++; peak = Math.max(peak, active); active--; return "third";
}, Date.now() + 3000);
await new Promise(resolve => setImmediate(resolve));
assert.equal(thirdStarted, false, "cancelling a queued caller cannot release the active controller's slot");
release(); assert.equal(await first, "first"); assert.equal(await third, "third"); assert.equal(peak, 1);
await assert.rejects(runH5CaptureForTesting(async () => { assert.fail("expired capture must not run"); }, Date.now() - 1));
assert.equal(await runH5CaptureForTesting(async () => "recovered", Date.now() + 3000), "recovered");
console.log("H5 controller serialization, queue cancellation and recovery passed");
