import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TrackNode } from "../models";
import { trackDisplayDetail } from "../services/status";
import { trackPhoneText } from "../services/track-phone-links";

const calls: string[] = [];
const text = "快递员电话：17717262250。联系电话【+86 138-0013-8000】，网点 0755-12345678，客服400-123-4567、95338。\n运单SF5111792798482、1238138001380009；日期2026-09-09，地址35号。";
const styled = trackPhoneText(text, (phone) => calls.push(phone));
assert.equal(styled.content.map((part) => typeof part === "string" ? part : part.content).join(""), text);
for (const part of styled.content) if (typeof part !== "string") part.onTapGesture();
assert.deepEqual(calls, ["17717262250", "+8613800138000", "075512345678", "4001234567", "95338"]);
assert.deepEqual(trackPhoneText("无电话：138****8000，单号JD13800138000", () => assert.fail()).content,
  ["无电话：138****8000，单号JD13800138000"]);
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
assert.match(page, /styledText=\{trackPhoneText\(trackDisplayDetail\(detailTimeline\.provider, track\), \(phone\) => \{ void dialPhone\(phone\); \}\)\}/);
assert.match(page, /Safari.openURL\(`tel:\$\{phone\}`\)/);
assert.match(page, /async function dialPhone\(phone: string\) \{[\s\S]*?Safari.openURL\(`tel:\$\{phone\}`\)/);
assert.match(page, /物流信息来自/);
assert.match(page, /<Text fontWeight="bold">\{timelineSourceName\}<\/Text>/);
assert.match(page, /sources\/kuaidi100/);

// Both Deliveries renderers recognize the same spans in the standalone distribution.
const source = readFileSync(new URL("../services/track-phone-links.ts", import.meta.url), "utf8");
const pattern = source.match(/const PHONE = \/(.*)\/g;/)![1];
for (const path of [
  "../../../app/src/main/java/me/pipi/deliveries/feature/express/ExpressTrackPhoneLinks.java",
]) {
  const java = readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(JSON.parse('"' + java.match(/Pattern.compile\("(.*)"\)/)![1] + '"'), pattern);
}

const jtBody = "运输中仍是正文。快递员电话：138-0013-8000。";
const jtTrack: TrackNode = {
  timeText: "2026-10-17 12:00:00",
  timeMs: null,
  detail: `派送中 ${jtBody}`,
  displayContext: jtBody,
  statusCode: "",
  raw: { _pipiStatusSource: "jt_h5", jtStatusLabel: "派送中" },
};

test("JT display body retains its phone link without adding the separate status label", () => {
  const dialed: string[] = [];
  const styled = trackPhoneText(trackDisplayDetail("jt_h5", jtTrack), (phone) => dialed.push(phone));
  assert.equal(styled.content.map((part) => typeof part === "string" ? part : part.content).join(""), jtBody);
  for (const part of styled.content) if (typeof part !== "string") part.onTapGesture();
  assert.deepEqual(dialed, ["13800138000"]);
  assert.equal(jtTrack.detail, `派送中 ${jtBody}`);
  assert.equal(jtTrack.raw.jtStatusLabel, "派送中");
});

test("legacy JT phone links keep the original full text when display text is absent", () => {
  const { displayContext: _displayContext, ...legacy } = jtTrack;
  const dialed: string[] = [];
  const styled = trackPhoneText(trackDisplayDetail("jt_h5", legacy), (phone) => dialed.push(phone));
  assert.equal(styled.content.map((part) => typeof part === "string" ? part : part.content).join(""), legacy.detail);
  for (const part of styled.content) if (typeof part !== "string") part.onTapGesture();
  assert.deepEqual(dialed, ["13800138000"]);
});

test("non-JT phone links ignore JT display metadata and keep the original full text", () => {
  const dialed: string[] = [];
  const styled = trackPhoneText(trackDisplayDetail("k100_h5", jtTrack), (phone) => dialed.push(phone));
  assert.equal(styled.content.map((part) => typeof part === "string" ? part : part.content).join(""), jtTrack.detail);
  for (const part of styled.content) if (typeof part !== "string") part.onTapGesture();
  assert.deepEqual(dialed, ["13800138000"]);
});
