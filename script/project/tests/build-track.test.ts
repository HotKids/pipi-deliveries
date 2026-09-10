import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GATEWAY_ORIGIN,
  SCRIPT_BUILD_TRACK,
  SCRIPT_CLIENT_BUILD,
  SCRIPT_VERSION,
} from "../services/build-track";

const manifest = JSON.parse(readFileSync(
  new URL("../script.json", import.meta.url),
  "utf8",
));
const track = String(SCRIPT_BUILD_TRACK);
assert.ok(track === "formal" || track === "beta", "the selected build track must be explicit");
assert.equal(manifest.version, SCRIPT_VERSION, "package and source versions must match");
assert.ok(Number.isSafeInteger(SCRIPT_CLIENT_BUILD) && SCRIPT_CLIENT_BUILD > 0,
  "the client build must be a positive safe integer");
if (track === "beta") {
  assert.match(SCRIPT_VERSION, /^\d+(?:\.\d+)*-beta\d+$/);
  assert.equal(GATEWAY_ORIGIN, "https://beta.pipiassistant.app");
} else {
  assert.match(SCRIPT_VERSION, /^\d+(?:\.\d+)*$/);
  assert.equal(GATEWAY_ORIGIN, "https://pipiassistant.app");
}
console.log("build track package consistency tests passed");
