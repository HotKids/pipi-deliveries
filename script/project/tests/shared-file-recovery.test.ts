import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installNativeSharedFiles } from "./shared-file-native";
import { sharedData, sharedStateText, publishSharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { emptyState, saveState, loadState } from "../services/storage";
const audit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../project-data/audits/ios-atomic-state-20260913");
fs.mkdirSync(audit, { recursive: true });
const root = fs.mkdtempSync(audit + "/recovery-");
installNativeSharedFiles(root);
const nativeLink = FileManager.createLinkSync;
try {
  withSharedFileTransaction(() => publishSharedData({}, "initial"));
  // Failure before publication leaves the old committed value readable.
  FileManager.createLinkSync = (p, target) => {
    if (p.endsWith("/next")) throw new Error("synthetic interrupted publication");
    nativeLink(p, target);
  };
  assert.throws(() => withSharedFileTransaction(() => publishSharedData({}, "uncommitted")), /interrupted/);
  FileManager.createLinkSync = nativeLink;
  assert.equal(sharedStateText(), "initial");
  // Losing the native success acknowledgement must not repeat a committed reducer.
  let calls = 0;
  FileManager.createLinkSync = (p, target) => {
    nativeLink(p, target);
    if (p.endsWith("/next")) throw new Error("synthetic lost acknowledgement");
  };
  withSharedFileTransaction(() => { calls++; publishSharedData({}, "committed"); });
  FileManager.createLinkSync = nativeLink;
  assert.equal(calls, 1);
  assert.equal(sharedStateText(), "committed");
  assert.equal(sharedStateText(true), "initial");
  // A crash between the successor link and the head hint remains discoverable.
  FileManager.createLinkSync = (p, target) => {
    if (/\/head-\d+$/.test(p) && !fs.existsSync(p)) throw new Error("synthetic missing head hint");
    nativeLink(p, target);
  };
  withSharedFileTransaction(() => publishSharedData({}, "after-link"));
  FileManager.createLinkSync = nativeLink;
  assert.equal(sharedStateText(), "after-link");
  // Corrupted existing journal metadata cannot become a writable empty store.
  const generation = fs.readdirSync(root + "/pipi-deliveries/transactions-v1")
    .filter(n => /^head-\d+$/.test(n)).sort((a,b)=>Number(b.slice(5))-Number(a.slice(5)))[0];
  const record = fs.readlinkSync(root + "/pipi-deliveries/transactions-v1/" + generation) + "/record.json";
  fs.writeFileSync(record, "{}");
  assert.throws(() => withSharedFileTransaction(() => publishSharedData({}, "replacement")), /checksum/);
  fs.rmSync(root, { recursive: true }); fs.mkdirSync(root);
  const initial = saveState(emptyState(), Date.now());
  const second = saveState(initial, Date.now());
  const current = sharedData().stateRef!;
  fs.writeFileSync(root + "/pipi-deliveries/transactions-v1/" + current + "/state.json", "corrupt");
  const recovered = loadState();
  assert.equal(recovered.revision, initial.revision, "business payload corruption recovers its independently verified previous generation");
  assert.notEqual(sharedData().stateRef, current, "recovery itself publishes through the same CAS boundary");
  assert.equal(JSON.parse(sharedStateText()!).schema, 3);
  assert.equal(second.revision, initial.revision + 1);
  console.log("Shared publication interruption, acknowledgement, head recovery and corruption tests passed");
} finally {
  FileManager.createLinkSync = nativeLink;
  fs.rmSync(root, { recursive: true, force: true });
}
