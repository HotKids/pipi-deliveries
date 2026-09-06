import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireProjectionViewport,
  projectionViewportHostAvailable,
  registerProjectionViewportHost,
  releaseProjectionViewport,
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

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const detailPage = readFileSync(join(projectRoot, "pages/DetailPage.tsx"), "utf8");
const projection = readFileSync(
  join(projectRoot, "services/account-order-projection.ts"),
  "utf8",
);

// The page registers itself while mounted and tears the registration down on unmount.
assert.ok(detailPage.includes("registerProjectionViewportHost({"));
assert.ok(detailPage.includes("registerProjectionViewportHost(null)"));
// The slot is transparent, non-interactive and behind the rows — never a visible web page.
assert.match(
  detailPage,
  /background=\{[\s\S]*?<WebView[\s\S]*?controller=\{projectionController\}[\s\S]*?opacity=\{0\}[\s\S]*?disabled=\{true\}/,
  "the hosted projection WebView must be an invisible, non-interactive background",
);
assert.equal(detailPage.includes("controller.present("), false);

// The viewport is acquired before the load and released in the projection's finally.
const acquireAt = projection.indexOf("await acquireProjectionViewport(controller)");
const loadAt = projection.indexOf("controller.loadURL(parcel.projectionUrl)");
assert.ok(acquireAt > 0 && loadAt > 0 && acquireAt < loadAt);
assert.ok(projection.includes("if (viewportHosted) releaseProjectionViewport();"));
assert.ok(projection.includes("viewportHosted,"));
assert.ok(projection.includes("viewportHosted: boolean;"));

console.log("projection viewport host tests passed");
