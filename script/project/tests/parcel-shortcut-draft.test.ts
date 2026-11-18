import assert from "node:assert/strict";
import { posix as Path } from "node:path";
import {
  PARCEL_SHORTCUT_PARAMETER,
  discardShortcutDraft,
  nextShortcutLookup,
  preferShortcutLookup,
  readScreenShortcutLookup,
  stageShortcutLookup,
  takeScreenShortcutLookup,
} from "../services/parcel-shortcut";

const number = "TEST81234567";
const files = new Map<string, { value: string; modificationDate: number }>();
let sequence = 0;
let onRead: (() => void) | undefined;

function file(path: string) {
  const item = files.get(path);
  if (!item) throw new Error("file missing");
  return item;
}

Object.assign(globalThis, {
  Path,
  UUID: { string: () => "aaaaaaaa-aaaa-4aaa-8aaa-" + String(++sequence).padStart(12, "0") },
  FileManager: {
    appGroupDocumentsDirectory: "/synthetic",
    createDirectorySync() {},
    existsSync(directory: string) {
      return [...files.keys()].some((path) => Path.dirname(path) === directory);
    },
    readDirectorySync(directory: string) {
      return [...files.keys()].filter((path) => Path.dirname(path) === directory);
    },
    statSync: file,
    writeAsStringSync(path: string, value: string) {
      files.set(path, { value, modificationDate: Date.now() });
    },
    readAsStringSync(path: string) {
      const item = file(path);
      onRead?.();
      return item.value;
    },
    renameSync(from: string, to: string) {
      const item = file(from);
      if (files.has(to)) throw new Error("destination exists");
      files.set(to, item);
      files.delete(from);
    },
    removeSync(path: string) { files.delete(path); },
  },
});

const lookup = {
  waybill: number, capturedAtMs: Date.now(), pickup: { code: "1-2-3456", locationName: "示例驿站" },
};
const later = { ...lookup, waybill: "TEST91234567", capturedAtMs: lookup.capturedAtMs + 1 };
const directory = "/synthetic/pipi-deliveries/shortcut-inbox";
function legacyDraft(token: string, modificationDate = Date.now()) {
  files.set(Path.join(directory, token), { value: JSON.stringify(lookup), modificationDate });
  return token;
}
const parameters = { [PARCEL_SHORTCUT_PARAMETER]: legacyDraft("bbbbbbbb-bbbb-4bbb-8bbb-000000000001.txt") };
let otherHost: unknown = "not read";
onRead = () => {
  onRead = undefined;
  otherHost = takeScreenShortcutLookup(parameters);
};
assert.deepEqual(takeScreenShortcutLookup(parameters), lookup);
assert.equal(otherHost, undefined, "a second script host cannot claim a draft while it is being read");
assert.equal(takeScreenShortcutLookup(parameters), undefined);
assert.equal(files.size, 0);

const screenToken = stageShortcutLookup(lookup, "screen");
const recovery = { ...lookup, draftToken: screenToken, openOnTap: true };
assert.deepEqual(nextShortcutLookup(), recovery);
assert.deepEqual(readScreenShortcutLookup(screenToken), lookup);
assert.equal(readScreenShortcutLookup("screen-../out-of-inbox.txt"), undefined);
const smsAfterScreen = stageShortcutLookup(later);
const awaitingConfirmation = { ...later, draftToken: smsAfterScreen };
assert.equal(readScreenShortcutLookup(smsAfterScreen), undefined);
assert.deepEqual(nextShortcutLookup(), awaitingConfirmation);
assert.equal(preferShortcutLookup(recovery, awaitingConfirmation), awaitingConfirmation);
assert.equal(preferShortcutLookup(awaitingConfirmation, recovery), awaitingConfirmation);
assert.equal(preferShortcutLookup(recovery, undefined), undefined);
discardShortcutDraft(smsAfterScreen);
discardShortcutDraft(screenToken);
assert.equal(readScreenShortcutLookup(screenToken), undefined);

const expired = { [PARCEL_SHORTCUT_PARAMETER]: legacyDraft("bbbbbbbb-bbbb-4bbb-8bbb-000000000002.txt", Date.now() - 301_000) };
assert.equal(takeScreenShortcutLookup(expired), undefined);
assert.equal(files.size, 0);
assert.throws(() => stageShortcutLookup({ ...lookup, waybill: "not a number" }));
assert.equal(takeScreenShortcutLookup({ [PARCEL_SHORTCUT_PARAMETER]: "../out-of-inbox.txt" }), undefined);

const laterToken = stageShortcutLookup(later);
const smsToken = legacyDraft("sms-bbbbbbbb-bbbb-4bbb-8bbb-000000000003.txt");
files.forEach((entry) => { entry.modificationDate -= 301_000; });
legacyDraft("bbbbbbbb-bbbb-4bbb-8bbb-000000000004.txt.writing", Date.now() - 301_000);
assert.equal(takeScreenShortcutLookup({ [PARCEL_SHORTCUT_PARAMETER]: smsToken }), undefined);
assert.equal(takeScreenShortcutLookup({ [PARCEL_SHORTCUT_PARAMETER]: laterToken }), undefined);
assert.deepEqual(nextShortcutLookup(), { ...lookup, draftToken: smsToken });
assert.deepEqual(nextShortcutLookup(), { ...lookup, draftToken: smsToken });
assert.equal(files.size, 2, "old unfinished foreground files expire while confirmed drafts remain");
discardShortcutDraft(smsToken);
assert.deepEqual(nextShortcutLookup(), { ...later, draftToken: laterToken });
discardShortcutDraft(laterToken);
assert.equal(nextShortcutLookup(), undefined);
assert.equal(files.size, 0);

console.log("Background Shortcut draft and legacy foreground claim tests passed");
