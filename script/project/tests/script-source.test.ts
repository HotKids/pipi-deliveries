import assert from "node:assert/strict";
import {
  SCRIPT_BINDING_SOURCE,
  SCRIPT_MANUAL_QUERY_SOURCE,
  requireScriptSource,
} from "../services/script-source";

assert.equal(SCRIPT_BINDING_SOURCE, "interface5");
assert.equal(SCRIPT_MANUAL_QUERY_SOURCE, "interface6");
const requiredSource: "interface5" = requireScriptSource("interface5");
assert.equal(requiredSource, "interface5");
assert.throws(
  () => requireScriptSource("interface6"),
  /当前快递服务不可用/,
);

console.log("script source boundary tests passed");
