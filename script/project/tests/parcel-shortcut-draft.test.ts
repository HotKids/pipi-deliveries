import assert from "node:assert/strict";
import { posix as Path } from "node:path";
import {
  PARCEL_SHORTCUT_PARAMETER,
  discardShortcutDraft,
  nextSmsShortcutLookup,
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
const parameters = { [PARCEL_SHORTCUT_PARAMETER]: stageShortcutLookup(lookup, "screen") };
let otherHost: unknown = "not read";
onRead = () => {
  onRead = undefined;
  otherHost = takeScreenShortcutLookup(parameters);
};
assert.deepEqual(takeScreenShortcutLookup(parameters), lookup);
assert.equal(otherHost, undefined, "a second script host cannot claim a draft while it is being read");
assert.equal(takeScreenShortcutLookup(parameters), undefined);
assert.equal(files.size, 0);

const expired = { [PARCEL_SHORTCUT_PARAMETER]: stageShortcutLookup(lookup, "screen") };
const expiredEntry = [...files.values()][0];
expiredEntry.modificationDate -= 301_000;
assert.equal(takeScreenShortcutLookup(expired), undefined);
assert.equal(files.size, 0);
assert.throws(() => stageShortcutLookup({ ...lookup, waybill: "not a number" }, "sms"));
assert.equal(takeScreenShortcutLookup({ [PARCEL_SHORTCUT_PARAMETER]: "../out-of-inbox.txt" }), undefined);

const later = { ...lookup, waybill: "TEST91234567", capturedAtMs: lookup.capturedAtMs + 1 };
const laterToken = stageShortcutLookup(later, "sms");
const smsToken = stageShortcutLookup(lookup, "sms");
files.forEach((entry) => { entry.modificationDate -= 301_000; });
const screen = stageShortcutLookup(lookup, "screen");
assert.equal(takeScreenShortcutLookup({ [PARCEL_SHORTCUT_PARAMETER]: smsToken }), undefined);
assert.deepEqual(nextSmsShortcutLookup(), { ...lookup, smsDraft: smsToken });
assert.deepEqual(nextSmsShortcutLookup(), { ...lookup, smsDraft: smsToken });
discardShortcutDraft(smsToken);
assert.deepEqual(nextSmsShortcutLookup(), { ...later, smsDraft: laterToken });
discardShortcutDraft(laterToken);
assert.equal(nextSmsShortcutLookup(), undefined);
discardShortcutDraft(screen);
assert.equal(files.size, 0);

console.log("Screen Shortcut claim and SMS draft acknowledgement tests passed");
