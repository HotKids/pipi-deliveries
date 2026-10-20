import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(projectRoot, path), "utf8");
const bindingSource = read("pages/PhoneBindingPage.tsx");
const managerSource = read("pages/PhoneManagerPage.tsx");
const detailSource = read("pages/DetailPage.tsx");
const thumbnailSource = read("components/ProductThumbnail.tsx");
const settingsSource = read("pages/SettingsPage.tsx");

// Execute the page's real handlers; only the host view tree and hooks are substituted.
function mountHandlers(source: string, name: string, props: any, exports: string, globals = {}) {
  const hookValues: any[] = [];
  const effectCleanups: Array<(() => void) | undefined> = [];
  const effectDeps: any[][] = [];
  let index = 0;
  let pendingEffects: Array<() => void> = [];
  const page = runInNewContext(stripTypeScriptTypes(
    `${source.replace("export function", "function")}\nreturn { ${exports} };\n}\n${name}`,
    { mode: "transform" },
  ), {
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    SCRIPT_BINDING_SOURCE: "interface5",
    EXPRESS_POLICY: { sources: { maxBindingsPerSource: 5 } },
    EXPRESS_TOAST_COPY: { codeSent: "sent", codeSendFailed: "send failed", bindFailed: "bind failed" },
    createDiagnosticFlowId: () => "synthetic-flow",
    diagnosticErrorDetails: () => ({}),
    writeDiagnostic: () => {},
    errorMessage: (_error: unknown, fallback: string) => fallback,
    useState(initial: any) {
      const at = index++;
      if (!(at in hookValues)) hookValues[at] = typeof initial === "function" ? initial() : initial;
      return [hookValues[at], (value: any) => {
        hookValues[at] = typeof value === "function" ? value(hookValues[at]) : value;
      }];
    },
    useRef(initial: any) {
      const at = index++;
      return hookValues[at] ??= { current: initial };
    },
    useEffect(effect: () => (() => void) | undefined, deps: any[]) {
      const at = index++;
      if (!effectDeps[at] || deps.some((value, item) => value !== effectDeps[at][item])) {
        pendingEffects.push(() => {
          effectCleanups[at]?.();
          effectCleanups[at] = effect();
          effectDeps[at] = deps;
        });
      }
    },
    ...globals,
  });
  return {
    render() {
      index = 0;
      pendingEffects = [];
      const value = page(props);
      for (const effect of pendingEffects) effect();
      return value;
    },
    unmount() { for (const cleanup of effectCleanups) cleanup?.(); },
  };
}

const handlers = bindingSource.slice(
  bindingSource.indexOf("function normalizedPhone("),
  bindingSource.indexOf("  return (\n    <List"),
);
const basePhone = "13800000000";
const bindings = Array.from({ length: 5 }, (_, index) => ({
  source: "interface5", phone: `1380000000${index}`, boundAtMs: 1,
}));
const sent: any[][] = [];
const bound: any[][] = [];
const binding = mountHandlers(handlers, "PhoneBindingPage", {
  bindings,
  onSendCode: async (...args: any[]) => { sent.push(args); },
  onBind: async (...args: any[]) => { bound.push(args); },
}, "phone, code, enhanced, verificationPhone, canBind, validationNotice, remainingSeconds, changePhone, changeCode, changeEnhanced, sendCode, bindPhone, setNowMs");
binding.render().changePhone("13900000000");
assert.equal(binding.render().canBind, false);
await binding.render().sendCode();
assert.equal(sent.length, 0, "a sixth basic phone cannot send a binding code");
binding.render().changeEnhanced(true);
assert.equal(binding.render().validationNotice, "请先完成该手机号的基础绑定，再开启增强模式");
await binding.render().sendCode();
assert.equal(sent.length, 0, "enhancement requires this exact phone's basic binding");
binding.render().changePhone(basePhone);
await binding.render().sendCode();
assert.equal(sent[0][0], basePhone);
assert.equal(sent[0][2], true, "five basic bindings must still allow enhancement");
binding.render().changeCode("123456789");
assert.equal(binding.render().code, "12345678");
assert.equal(binding.render().canBind, true);
await binding.render().bindPhone();
assert.equal(bound[0][1], "12345678");
assert.equal(bound[0][3], true);
binding.render().changeEnhanced(false);
assert.equal(binding.render().code, "");
assert.equal(binding.render().verificationPhone, "");
assert.ok(binding.render().remainingSeconds > 0, "changing mode preserves the SMS cooldown");
await binding.render().sendCode();
assert.equal(sent.length, 1, "mode switching cannot resend during the cooldown");
binding.render().changeCode("12345678");
assert.equal(binding.render().code, "123456");
assert.equal(binding.render().canBind, false, "an enhanced code cannot authorize basic binding");
binding.render().setNowMs(Date.now() + 61_000);
await binding.render().sendCode();
assert.equal(sent[1][2], false);
binding.render().changeCode("1234");
await binding.render().bindPhone();
assert.equal(bound[1][3], false);
binding.unmount();

let finishSend!: () => void;
const late = mountHandlers(handlers, "PhoneBindingPage", {
  bindings: [],
  onSendCode: () => new Promise<void>((resolve) => { finishSend = resolve; }),
  onBind: () => {},
}, "changePhone, sendCode, verificationPhone");
late.render().changePhone(basePhone);
const pendingSend = late.render().sendCode();
late.unmount();
finishSend();
await pendingSend;
assert.equal(late.render().verificationPhone, "", "a dismissed page cannot accept a late SMS result");

const managerBindings: Array<{ finish: () => void }> = [];
let managerHandlers = managerSource.slice(
  managerSource.indexOf("export function PhoneManagerPage("),
  managerSource.indexOf("  return (\n    <List"),
);
const inlineBind = managerSource.match(/onBind=\{(async \([\s\S]*?\n            \})\}/)?.[1];
if (inlineBind) {
  managerHandlers += `const bind = ${inlineBind};\nconst changeBindingPresentation = setBindingPresented;\n`;
}
const manager = mountHandlers(managerHandlers, "PhoneManagerPage", {
  bindings,
  stateRevision: 1,
  busy: false,
  onBind: () => new Promise<void>((finish) => { managerBindings.push({ finish }); }),
}, "add, changeBindingPresentation, bind, bindingPresented, notice", {
  EXPRESS_TOAST_COPY: { phoneBound: "bound" },
});
manager.render().add();
const previousBind = manager.render().bind(basePhone, "12345678", "previous-flow", true);
manager.render().changeBindingPresentation(false);
manager.render().add();
managerBindings[0].finish();
await previousBind;
assert.equal(manager.render().bindingPresented, true, "a previous enhancement cannot close a newly opened form");
assert.equal(manager.render().notice, "", "a previous enhancement cannot show success on the new form");
const currentBind = manager.render().bind(basePhone, "12345678", "current-flow", true);
managerBindings[1].finish();
await currentBind;
assert.equal(manager.render().bindingPresented, false, "the current form closes after successful binding");
assert.equal(manager.render().notice, "bound");
manager.unmount();

const settingsCalls: any[][] = [];
const settingsBindings = { bindings };
const settingsScope = {
  SCRIPT_BINDING_SOURCE: "interface5",
  props: { state: settingsBindings, onStateChange: () => {} },
  diagnosticState: () => ({}),
  diagnosticErrorDetails: () => ({}),
  writeDiagnostic: () => {},
  bindPhone: async (...args: any[]) => { settingsCalls.push(args); return settingsBindings; },
  refreshAllShipments: async () => ({ state: settingsBindings }),
  loadState: () => settingsBindings,
  requireEnhancementBinding: (_bindings: unknown, phone: string) => { settingsCalls.push(["require", phone]); },
  enhancementOperation: async (...args: any[]) => { settingsCalls.push(args); },
  sendAccountCode: async (...args: any[]) => { settingsCalls.push(args); },
  setManagerNotice: () => { assert.fail("binding success belongs to the current manager generation"); },
};
const settingsBindText = settingsSource.slice(
  settingsSource.indexOf("async function bindCurrentPhone("),
  settingsSource.indexOf("  const boundPhoneCount"),
);
const settingsBind = runInNewContext(
  `${stripTypeScriptTypes(settingsBindText)}\nbindCurrentPhone`, settingsScope,
);
await settingsBind(basePhone, "12345678", "synthetic-enhanced", true);
assert.equal(settingsCalls[0][4], true, "Settings must forward enhancement to the binding service");
await settingsBind(basePhone, "123456", "synthetic-basic");
assert.equal(settingsCalls[1][4], false, "ordinary binding keeps its basic mode");
const settingsSendText = settingsSource.match(/onSendCode=\{(\(phone, _flowId, enhanced\) => \{[\s\S]*?\n              \})\}/)?.[1];
assert.ok(settingsSendText, "Settings must accept the binding page's selected mode");
const settingsSend = runInNewContext(`(${settingsSendText})`, settingsScope);
await settingsSend(basePhone, "synthetic-flow", true);
assert.equal(settingsCalls[2][0], "require");
assert.equal(settingsCalls[3][0], "code");
await settingsSend(basePhone, "synthetic-flow", false);
assert.equal(settingsCalls[4][0], "interface5");

const appearStart = detailSource.indexOf("    if (props.refreshOnAppear ||");
const appearEnd = detailSource.indexOf("    return () => {", appearStart);
assert.ok(appearStart >= 0 && appearEnd > appearStart);
for (const [identity, refreshOnAppear, expectedCalls] of [
  [{ accountOrder: true, sourceProvider: "jingdong" }, false, 1],
  [{ accountOrder: true, sourceProvider: "jingdong", productImageURL: "https://img.jd.com/known.jpg" }, false, 0],
  [{ accountOrder: true, sourceProvider: "CaiNiao" }, false, 0],
  [{ manuallyAdded: true }, false, 0],
  [{ accountOrder: true, sourceProvider: "jingdong" }, "detail_open", 1],
] as const) {
  let refreshes = 0;
  runInNewContext(detailSource.slice(appearStart, appearEnd), {
    props: { shipment: { identity }, refreshOnAppear },
    refresh: () => { refreshes++; },
    setLoadingManualDetail: () => {},
  });
  assert.equal(refreshes, expectedCalls,
    "a frozen JD detail can request a missing image without enabling other detail refreshes");
}

const imageRequests: Array<{ url: string; signal: AbortSignal; finish: (image: any) => void }> = [];
const imageProps = { imageURL: "", cacheKey: "", courierCode: "JD", companyName: "京东快递", size: 72 };
const thumbnail = mountHandlers(thumbnailSource.slice(
  thumbnailSource.indexOf("export function ProductThumbnail("),
  thumbnailSource.indexOf("  if (!image) {"),
), "ProductThumbnail", imageProps, "image", {
  cachedProductImage: () => null,
  productImageCacheKey: (identity: any) => identity.id,
  loadState: () => ({ shipments: [{ identity: { id: imageProps.cacheKey } }] }),
  loadProductImage: (url: string, signal: AbortSignal) => new Promise((finish) => {
    imageRequests.push({ url, signal, finish });
  }),
});
assert.equal(thumbnail.render().image, null);
assert.equal(imageRequests.length, 0);
imageProps.imageURL = "https://img10.360buyimg.com/synthetic-first.png";
imageProps.cacheKey = "synthetic-order-one";
assert.equal(thumbnail.render().image, null);
imageRequests[0].finish({ syntheticImage: 1 });
await Promise.resolve();
assert.equal(thumbnail.render().image.syntheticImage, 1);
imageProps.imageURL = "https://img10.360buyimg.com/synthetic-next.png";
assert.equal(thumbnail.render().image.syntheticImage, 1, "a changed address keeps this record's successful image");
assert.equal(imageRequests[0].signal.aborted, true);
imageRequests[1].finish(null);
await Promise.resolve();
assert.equal(thumbnail.render().image.syntheticImage, 1, "an optional refresh failure keeps this record's successful image");
imageProps.cacheKey = "synthetic-order-two";
assert.equal(thumbnail.render().image, null, "a different record immediately hides the previous product image");
imageRequests[2].finish(null);
await Promise.resolve();
assert.equal(thumbnail.render().image, null, "a record without a successful image keeps the carrier icon");
imageProps.imageURL = "https://img10.360buyimg.com/synthetic-last.png";
thumbnail.render();
thumbnail.unmount();
assert.equal(imageRequests[3].signal.aborted, true);
imageRequests[3].finish({ syntheticImage: 3 });
await Promise.resolve();
assert.equal(thumbnail.render().image, null, "a dismissed detail ignores a late product image");

assert.ok(bindingSource.indexOf('prompt="请输入验证码"') < bindingSource.indexOf('title="增强模式"'));
assert.match(managerSource, /<PhoneBindingPage\s+bindings=\{props\.bindings\}/);
assert.match(managerSource, /foregroundStyle=\{binding\.enhancedMode \? "#0478FB" : "#FF6900"\}/);
assert.ok(managerSource.includes("增强模式不占用绑定数量。"));
assert.doesNotMatch(managerSource, /disabled=\{\s*busy \|\|\s*visibleBindings\.length/);
assert.match(detailSource, /<ProductThumbnail[\s\S]*?size=\{72\}[\s\S]*?cornerRadius=\{17\}[\s\S]*?imageURL=\{shipment\.identity\.productImageURL\}/);
assert.match(detailSource, /refreshShipmentById\(props\.shipment\.identity\.id, \{\s*requestProductImage: true/);
assert.match(thumbnailSource, /cornerRadius: props\.size \* 0\.25/);
assert.doesNotMatch(thumbnailSource, /imageUrl=|UIImage\.fromURL/);

console.log("enhanced mode UI handler tests passed");
