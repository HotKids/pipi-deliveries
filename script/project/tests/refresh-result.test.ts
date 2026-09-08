import assert from "node:assert/strict";
import { refreshIntentMessage } from "../services/refresh-result";

assert.equal(
  refreshIntentMessage({ attempted: 3, succeeded: 3, failed: 0 }),
  "已更新 3 票快递。",
);
assert.equal(
  refreshIntentMessage({ attempted: 3, succeeded: 2, failed: 1 }),
  "已更新 2 票，1 票更新失败。",
);
assert.equal(
  refreshIntentMessage({ attempted: 0, succeeded: 0, failed: 0 }),
  "暂无需要更新的快递。",
);
assert.equal(
  refreshIntentMessage({ attempted: 2, succeeded: 0, failed: 2 }),
  "快递更新失败，请稍后重试。",
);

console.log("refresh result copy tests passed");
