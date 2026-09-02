import assert from "node:assert/strict";
import {
  GATEWAY_ORIGIN,
  SCRIPT_BUILD_TRACK,
  SCRIPT_CLIENT_BUILD,
  SCRIPT_VERSION,
} from "../services/build-track";

assert.equal(SCRIPT_BUILD_TRACK, "formal");
assert.equal(SCRIPT_VERSION, "0.5");
assert.equal(SCRIPT_CLIENT_BUILD, 39);
assert.equal(GATEWAY_ORIGIN, "https://pipiassistant.app");
