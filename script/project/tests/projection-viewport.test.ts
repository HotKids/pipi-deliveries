import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireProjectionViewport,
  createProjectionViewportHost,
  projectionViewportHostAvailable,
  registerProjectionViewportHost,
  releaseProjectionViewport,
  type ProjectionViewportView,
} from "../services/projection-viewport";

// AGENTS §9 / backlog D-15 裁决 A′ (2026-09-04): the JingDong union page mounts its floors by
// viewport intersection, so a headless controller never renders 「完整物流进度」. The visible
// detail page lends the projection its bounds; without a host the projection stays headless.

const controller = { id: "controller" };

assert.equal(projectionViewportHostAvailable(), false);
assert.equal(await acquireProjectionViewport(controller), false);
releaseProjectionViewport(); // must not throw without a host

let mounted: unknown = null;
let unmounts = 0;
registerProjectionViewportHost({
  mount: async (value) => {
    mounted = value;
    return true;
  },
  unmount: () => {
    unmounts += 1;
    mounted = null;
  },
});
assert.equal(projectionViewportHostAvailable(), true);
assert.equal(await acquireProjectionViewport(controller), true);
assert.equal(mounted, controller);
releaseProjectionViewport();
assert.equal(unmounts, 1);
assert.equal(mounted, null);

// A page that refuses (already unmounting) or throws leaves the projection headless, never failed.
registerProjectionViewportHost({
  mount: async () => false,
  unmount: () => { unmounts += 1; },
});
assert.equal(await acquireProjectionViewport(controller), false);
registerProjectionViewportHost({
  mount: async () => { throw new Error("page is gone"); },
  unmount: () => { throw new Error("page is gone"); },
});
assert.equal(await acquireProjectionViewport(controller), false);
releaseProjectionViewport(); // a throwing host must not escape into the projection

registerProjectionViewportHost(null);
assert.equal(projectionViewportHostAvailable(), false);
assert.equal(await acquireProjectionViewport(controller), false);
assert.equal(await acquireProjectionViewport(null), false);

let presented: ProjectionViewportView | null = null;
const nativeHost = createProjectionViewportHost((view) => { presented = view; });
let firstReady = false;
const firstMount = nativeHost.mount(controller).then((ready) => { firstReady = ready; return ready; });
const firstView = presented!;
await Promise.resolve();
assert.equal(firstReady, false, "the state update alone does not confirm a rendered viewport");
assert.equal(firstView.controller, controller);
firstView.appeared();
assert.equal(await firstMount, true);
nativeHost.unmount();
assert.equal(presented, null);

let secondReady = false;
const secondMount = nativeHost.mount(controller).then((ready) => { secondReady = ready; return ready; });
const secondView = presented!;
assert.notEqual(secondView.id, firstView.id, "reusing the same controller still creates a fresh host mount");
firstView.appeared();
await Promise.resolve();
assert.equal(secondReady, false, "a stale native callback cannot complete a different mount");
nativeHost.unmount();
assert.equal(await secondMount, false, "closing the host releases an unanswered mount");

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const detailPage = readFileSync(join(projectRoot, "pages/DetailPage.tsx"), "utf8");
const app = readFileSync(join(projectRoot, "index.tsx"), "utf8");
const projection = readFileSync(
  join(projectRoot, "services/account-order-projection.ts"),
  "utf8",
);

// One app-owned slot survives Home/detail navigation. Popping detail cannot clear Home's host.
assert.ok(app.includes("registerProjectionViewportHost(viewportHost)"));
assert.ok(app.includes("registerProjectionViewportHost(null)"));
assert.equal(detailPage.includes("registerProjectionViewportHost"), false);
// Match the positive capture alpha used by Pipi's ExpressHiddenWebView.
assert.match(
  app,
  /<TabView[\s\S]*?background=\{[\s\S]*?<WebView[\s\S]*?opacity=\{0\.01\}/,
  "the background WebView must remain renderable at Pipi's capture alpha",
);
assert.match(app, /size\.width > 0 && size\.height > 0 \? \(\s*<WebView/);
assert.match(app, /<WebView[\s\S]*?onAppear=\{projectionView\.appeared\}/);
assert.match(app, /<WebView[\s\S]*?allowsHitTesting=\{false\}[\s\S]*?disabled=\{true\}/);
assert.equal(app.includes("controller.present("), false);

// The viewport is acquired before the load and released in the projection's finally.
const acquireAt = projection.indexOf("acquireProjectionViewport(controller)");
const loadAt = projection.indexOf("controller.loadURL(parcel.projectionUrl)");
assert.ok(acquireAt > 0 && loadAt > 0 && acquireAt < loadAt);
assert.ok(projection.includes("releaseProjectionViewport();"));
assert.ok(projection.includes("viewportHosted,"));
assert.ok(projection.includes("viewportHosted: boolean;"));

console.log("projection viewport host tests passed");
