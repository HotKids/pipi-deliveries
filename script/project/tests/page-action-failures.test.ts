import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

function action(path: string, begin: string, end: string, scope: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const text = source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin)));
  const code = stripTypeScriptTypes(text);
  const name = /function (\w+)/.exec(begin)![1];
  return Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

test("note storage failure is contained and reported without replacing displayed data", async () => {
  let notice = "", published = false;
  const edit = action("../pages/DetailPage.tsx", "async function editNote()", "const [loadingManualDetail", {
    Dialog: { prompt: async () => "Synthetic note" }, shipment: { identity: { id: "synthetic" } },
    setShipmentNote: () => { throw new Error("Synthetic storage failure"); },
    writeDiagnostic: () => {}, diagnosticErrorDetails: () => ({}), setNotice: (value: string) => { notice = value; },
    setShipment: () => { published = true; }, props: {}, requestWidgetReload: () => {},
  });
  await edit();
  assert.equal(notice, "保存失败，请稍后重试");
  assert.equal(published, false);
});

test("authorization action-sheet failure is contained by its page action", async () => {
  let notice = "";
  const manage = action("../pages/SettingsPage.tsx", "async function manageConfiguredToken()", "function openPhoneManager()", {
    Dialog: { actionSheet: async () => { throw new Error("Synthetic prompt failure"); } },
    setNotice: (value: string) => { notice = value; }, removeToken: async () => { assert.fail("no choice was made"); },
  });
  await manage();
  assert.equal(notice, "操作失败，请稍后重试");
});

test("authorization confirmation failure is contained before removal", async () => {
  let notice = "";
  const remove = action("../pages/SettingsPage.tsx", "async function removeToken()", "async function manageConfiguredToken()", {
    Dialog: { confirm: async () => { throw new Error("Synthetic confirmation failure"); } },
    setNotice: (value: string) => { notice = value; }, refreshAuthorization: () => "authorized",
    removeGatewayToken: () => { assert.fail("confirmation did not succeed"); }, setToken: () => {},
  });
  await remove();
  assert.equal(notice, "Access Key 移除失败，请稍后重试");
});
