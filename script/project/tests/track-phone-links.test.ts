import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
assert.match(page, /styledText=\{trackPhoneText\(track.detail/);
assert.match(page, /Safari.openURL\(`tel:\$\{phone\}`\)/);
assert.match(page, /物流信息来自/);
assert.match(page, /<Text fontWeight="bold">\{timelineSourceName\}<\/Text>/);
assert.match(page, /sources\/kuaidi100/);

// The three native detail renderers recognize the same spans.
const source = readFileSync(new URL("../services/track-phone-links.ts", import.meta.url), "utf8");
const pattern = source.match(/const PHONE = \/(.*)\/g;/)![1];
for (const path of [
  "../../../../flutter_app/android/app/src/main/java/me/pipi/assistant/express/ExpressTrackPhoneLinks.java",
  "../../../app/src/main/java/me/pipi/deliveries/feature/express/ExpressTrackPhoneLinks.java",
]) {
  const java = readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(JSON.parse('"' + java.match(/Pattern.compile\("(.*)"\)/)![1] + '"'), pattern);
}
