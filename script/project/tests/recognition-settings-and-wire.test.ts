import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizedRecognitionURL, prepareRecognitionConfig, providerDefaults, recognitionOperation,
  recognitionSettings, saveRecognitionSettings, type RecognitionDraft } from "../services/recognition/settings";
import { parseRecognitionResult, providerRecognitionText, recognitionRequest, recognitionSchema } from "../services/recognition/wire";

const protectedInput = new Map<string, string>();
Object.assign(globalThis, { UUID: { string: randomUUID }, Keychain: {
  get: (name: string) => protectedInput.get(name),
  set: (name: string, value: string) => { protectedInput.set(name, value); return true; },
} });
assert.equal(recognitionSettings().draft.mode, "local");
assert.equal(recognitionOperation().config, undefined);
const online: RecognitionDraft = { ...providerDefaults("compatible"), mode: "online", providerName: "Synthetic",
  baseUrl: "https://synthetic.invalid/v1", model: "vision-fixture" };
assert.throws(() => normalizedRecognitionURL("compatible", "https://example:info@synthetic.invalid/v1/"));
assert.throws(() => normalizedRecognitionURL("compatible", "http://synthetic.invalid/v1/"));
assert.throws(() => normalizedRecognitionURL("compatible", "https://synthetic.invalid/v1?x=1"));
assert.throws(() => prepareRecognitionConfig(online, ""));
const fixtureKey = "synthetic-key";
saveRecognitionSettings(online, fixtureKey);
assert.deepEqual(recognitionSettings().draft, online);
assert.equal(recognitionSettings().keyLength, fixtureKey.length);
assert.doesNotMatch(JSON.stringify(recognitionSettings()), /synthetic-key/);
const prior = recognitionOperation();
assert.ok(prior.isCurrent());
assert.throws(() => prepareRecognitionConfig({ ...online, baseUrl: "https://different.invalid/v1" }, ""));
assert.throws(() => prepareRecognitionConfig({ ...providerDefaults("gemini"), mode: "online", model: "vision" }, ""));
saveRecognitionSettings({ ...online, mode: "local" }, "");
assert.equal(recognitionOperation().mode, "local");
assert.equal(prior.isCurrent(), false);
assert.equal(prepareRecognitionConfig(online, "").baseUrl, online.baseUrl);

const pickup = { brand: "Synthetic", pickupCode: "0123", productName: null, merchantName: null, itemCount: 2, totalAmount: "00.50" };
const result = { pickup, express: null, train: null, flight: null, movie: null };
const extraction = JSON.stringify(result);
assert.deepEqual(parseRecognitionResult(extraction), { family: "pickup", fields: pickup });
assert.equal(parseRecognitionResult(JSON.stringify({ ...result, pickup: null })), null);
for (const invalid of [
  extraction.replace('"pickupCode":', '"pickupCode":null,"pickupCode":'),
  extraction.replace('"0123"', '"12**"'),
  JSON.stringify({ ...result, express: { waybill: "TEST12345678", pickupCode: null } }),
  JSON.stringify({ ...result, pickup: { ...pickup, totalAmount: 0.5 } }),
  JSON.stringify({ ...result, pickup: { ...pickup, qrPayload: "invented" } }),
]) assert.throws(() => parseRecognitionResult(invalid));

const config = prepareRecognitionConfig(online, "");
const chat = recognitionRequest(config, "Synthetic prompt", "SYNTHETIC_DATA");
assert.equal(chat.url, online.baseUrl + "/chat/completions");
const chatBody = JSON.parse(chat.body);
assert.equal(chatBody.messages[1].content[0].image_url.url, "data:image/jpeg;base64,SYNTHETIC_DATA");
assert.deepEqual(chatBody.response_format.json_schema.schema, recognitionSchema);
const responses = JSON.parse(recognitionRequest({ ...config, protocol: "responses" }, "Synthetic prompt", "SYNTHETIC_DATA").body);
assert.equal(responses.store, false);
assert.equal(responses.input[0].content[0].type, "input_image");
const gemini = JSON.parse(recognitionRequest({ ...config, protocol: "gemini" }, "Synthetic prompt", "SYNTHETIC_DATA", false).body);
assert.equal(gemini.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
assert.equal(gemini.generationConfig.thinkingConfig, undefined);

const reply = { status: "completed", output: [{ type: "message", role: "assistant",
  content: [{ type: "output_text", text: extraction }] }] };
assert.equal(providerRecognitionText("responses", JSON.stringify(reply)), extraction);
assert.throws(() => providerRecognitionText("responses", JSON.stringify({ ...reply, status: "incomplete" })));
assert.throws(() => providerRecognitionText("chat_completions", JSON.stringify({
  choices: [{ finish_reason: "stop", message: { refusal: "Synthetic refusal" } }],
})));
assert.equal(providerRecognitionText("gemini", JSON.stringify({ candidates: [{ finishReason: "STOP",
  content: { parts: [{ thought: true, text: "ignored" }, { text: extraction }] } }] })), extraction);

const page = readFileSync(new URL("../pages/RecognitionSettingsPage.tsx", import.meta.url), "utf8");
const start = page.indexOf("  async function testConnection() {");
const end = page.indexOf("\n  function save()", start);
const copyStart = page.indexOf("const CONNECTION_TESTING =");
const copyEnd = page.indexOf("\nfunction ProviderLogo", copyStart);
assert.ok(start >= 0 && end > start && copyStart >= 0 && copyEnd > copyStart);
const makeConnectionTest = new Function(
  "cancelTest", "setValidation", "request", "prepareRecognitionConfig", "draft", "key", "setTesting", "setNotice",
  "UIImage", "Script", "requestOnlineRecognition", "CONNECTION_TEST_BUDGET_MS", "RecognitionSettingError",
  `${page.slice(copyStart, copyEnd)}\nreturn (${page.slice(start, end).trim()});`,
);
for (const outcome of ["success", "failure", "cancel"]) {
  const notices: string[] = [];
  const busy: boolean[] = [];
  const request = { current: null as AbortController | null };
  let complete!: (value: unknown) => void;
  const response = new Promise(resolve => { complete = resolve; });
  const run = makeConnectionTest(
    () => {}, () => {}, request, prepareRecognitionConfig, online, "", (value: boolean) => busy.push(value),
    (message: string) => notices.push(message), { fromFile: () => ({}) }, { directory: "/fixture" },
    () => response, 5_000, Error,
  ) as () => Promise<void>;
  const pending = run();
  assert.deepEqual(notices, ["正在测试连接"]);
  if (outcome === "cancel") {
    request.current?.abort();
    request.current = null;
  }
  complete(outcome === "failure" ? null : { family: "pickup", fields: pickup });
  await pending;
  assert.deepEqual(notices, outcome === "cancel" ? ["正在测试连接"] : ["正在测试连接",
    outcome === "success" ? "连接测试成功" : "连接测试失败，请检查在线识别配置"]);
  assert.deepEqual(busy, outcome === "cancel" ? [true] : [true, false]);
}
console.log("Online recognition settings and provider wire tests passed");
