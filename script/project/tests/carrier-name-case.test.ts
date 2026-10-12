import assert from "node:assert/strict";
import { resolveCarrierName } from "../services/carrier-query";
import { hasBuiltInAccountCarrierName } from "../services/account-carrier-normalization";

// Audit C11 (adopted 2026-09-25): carrier names match without letter case, as on Pipi, Lite and the
// Worker. A lower-case 「ems」 is the table's EMS and must not start a recognition request.
for (const name of ["EMS", "ems", "Ems", " e m s ", "邮政ems"]) {
  assert.equal(resolveCarrierName(name)?.standardCode, "EMS", name);
}
assert.equal(hasBuiltInAccountCarrierName("ems"), true);
// Names that differ in more than case still do not match.
assert.equal(resolveCarrierName("emsx"), null);

console.log("carrier name case tests passed");
