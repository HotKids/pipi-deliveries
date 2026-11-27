import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { ShipmentLifecycleChangedError } from "../services/shipment-lifecycle";

function action(path: string, begin: string, end: string, scope: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const text = source.slice(source.indexOf(begin), source.indexOf(end, source.indexOf(begin)));
  const code = stripTypeScriptTypes(text);
  const name = /function (\w+)/.exec(begin)![1];
  return Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

test("product name storage failure is contained and reported without replacing displayed data", async () => {
  let notice = "", published = false;
  const edit = action("../pages/DetailPage.tsx", "async function editProductName()", "const [loadingManualDetail", {
    ShipmentLifecycleChangedError,
    Dialog: { prompt: async () => "Synthetic note" }, shipment: { identity: { id: "synthetic" } },
    platformFields: {},
    setShipmentProductName: () => { throw new Error("Synthetic storage failure"); },
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

// G-HIGH-17 (2026-11-20 review): a gesture's async callback that throws must not end the Scripting session.
test("opening an identity code contains a failed route or account read", async () => {
  for (const failure of ["route", "account"] as const) {
    let notice = "", identity: unknown = "unset";
    const open = action("../pages/PickupPage.tsx", "async function openIdentity(platform: IdentityPlatform)", "// end useStationIdentityNavigation", {
      identityRequest: { current: 0 }, onBeforeOpen: undefined, Safari: { openURL: async () => false },
      stationIdentityDestination: async () => {
        if (failure === "route") throw new Error("Synthetic keychain failure");
        return "login";
      },
      accountStatus: () => { throw new Error("Synthetic keychain failure"); },
      setIdentity: (value: unknown) => { identity = value; },
      showNotice: (value: string) => { notice = value; },
      writeDiagnostic: () => {}, diagnosticErrorDetails: () => ({}),
      EXPRESS_TOAST_COPY: { pickupRecordActionFailed: "操作失败，请稍后重试" },
    });
    await open("cainiao");
    assert.equal(notice, "操作失败，请稍后重试", failure);
    assert.equal(identity, "unset", `${failure}: nothing is presented`);
  }
});

test("the diagnostics page actions contain a failed log read or prompt", async () => {
  for (const failure of ["read", "prompt"] as const) {
    let notice = "";
    const actions = action("../pages/DiagnosticLogPage.tsx", "async function actions()", "\n  return (\n", {
      readDiagnostics: () => {
        if (failure === "read") throw new Error("Synthetic storage failure");
        return [];
      },
      showItems: () => {}, recording: false,
      Dialog: { actionSheet: async () => { throw new Error("Synthetic prompt failure"); } },
      setNotice: (value: string) => { notice = value; }, ACTION_FAILED_TOAST: "操作失败，请稍后重试",
    });
    await actions();
    assert.equal(notice, "操作失败，请稍后重试", failure);
  }
});

// G-HIGH-18 (2026-11-20 review): the Live Activity settings show only the service's own Chinese messages, and a
// page that has gone away is not updated.
test("Live Activity settings map host errors to a controlled message and stop after unmounting", async () => {
  class ParcelActivityError extends Error {}
  const run = async (thrown: unknown, unmountDuringAction = false) => {
    const calls: string[] = [];
    let notice = "";
    const mounted = { current: true };
    const change = action("../pages/PickupSettingsPages.tsx", "async function change(", "const closePreview", {
      busy: false, mounted, ParcelActivityError,
      setBusy: (value: boolean) => calls.push(`busy:${value}`),
      setActivity: () => calls.push("activity"),
      setNotice: (value: string) => { calls.push("notice"); notice = value; },
      parcelActivityStatus: async () => ({ showAll: false, previewing: false, lockScreenStyle: "dynamic" }),
    });
    await change(async () => {
      if (unmountDuringAction) mounted.current = false;
      throw thrown;
    });
    return { calls, notice };
  };
  assert.equal((await run(new Error("The operation couldn’t be completed. (ActivityKit error 1.)"))).notice,
    "实时活动操作失败，请稍后重试", "a host message never reaches the page");
  assert.equal((await run(new ParcelActivityError("请先结束当前实时活动。"))).notice, "请先结束当前实时活动。");
  assert.deepEqual((await run(new Error("Synthetic"), true)).calls, ["busy:true"],
    "an unmounted page receives no notice, status or busy update");
});

// G-LOW-04 (2026-11-20 review): editing a handoff window tells a changed card from a failed save, as Pipi's pickup
// card does ('changed' → 卡片已更新，请重试, otherwise 保存失败，请稍后重试).
test("a handoff window edit distinguishes a changed card from a failed save", async () => {
  const { PICKUP_TOAST_COPY } = await import("../services/express-toast-copy");
  const { SAVE_FAILED_TOAST } = await import("../services/ui-feedback");
  for (const [thrown, expected] of [[new ShipmentLifecycleChangedError(), "卡片已更新，请重试"],
    [new Error("Synthetic storage failure"), "保存失败，请稍后重试"], [undefined, "已保存"]] as const) {
    let notice = "";
    const edit = action("../pages/PickupPage.tsx", "async function editWindow()", "async function complete()", {
      editing: { current: false },
      onSaveWindow: () => { if (thrown) throw thrown; },
      Dialog: { prompt: async () => "" },
      card: { location: "" }, parseHandoffWindow: () => undefined,
      showNotice: (value: string) => { notice = value; },
      ShipmentLifecycleChangedError, PICKUP_TOAST_COPY, SAVE_FAILED_TOAST,
    });
    await edit();
    assert.equal(notice, expected);
  }
});
