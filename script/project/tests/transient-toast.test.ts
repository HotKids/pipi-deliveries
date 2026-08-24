import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transientToast } from "../services/ui-feedback";

let dismissedMessage = "unchanged";
const visibleToast = transientToast("运单号已复制", (message) => {
  dismissedMessage = message;
});
assert.equal(visibleToast.isPresented, true);
assert.equal(visibleToast.message, "运单号已复制");
assert.equal(visibleToast.duration, 2);
assert.equal(visibleToast.position, "bottom");
visibleToast.onChanged(true);
assert.equal(dismissedMessage, "unchanged");
visibleToast.onChanged(false);
assert.equal(dismissedMessage, "");
assert.equal(transientToast("", () => {}).isPresented, false);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transientPages = [
  "DetailPage.tsx",
  "DiagnosticLogPage.tsx",
  "HomePage.tsx",
  "NotificationSettingsPage.tsx",
  "PhoneBindingPage.tsx",
  "PhoneManagerPage.tsx",
  "SettingsPage.tsx",
];

for (const file of transientPages) {
  const source = await readFile(resolve(projectDir, "pages", file), "utf8");
  assert.ok(
    source.includes('import { transientToast } from "../services/ui-feedback";'),
    `${file} must use the shared transient feedback presentation`,
  );
  assert.ok(
    source.includes("toast={transientToast(notice, setNotice)}"),
    `${file} must show operation feedback without occupying page layout`,
  );
  assert.doesNotMatch(
    source,
    /\{notice \? \([\s\S]{0,180}?<Text/,
    `${file} must not render transient notice text inline`,
  );
}

const phoneBindingSource = await readFile(
  resolve(projectDir, "pages/PhoneBindingPage.tsx"),
  "utf8",
);
assert.ok(
  phoneBindingSource.includes("{validationNotice ? ("),
  "phone and verification-code validation must remain inline",
);

const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
assert.ok(
  homeSource.includes("{validationNotice ? ("),
  "manual-query validation must remain inline",
);

console.log("transient toast presentation tests passed");
