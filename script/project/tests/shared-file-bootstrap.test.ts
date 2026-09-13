import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installNativeSharedFiles } from "./shared-file-native";
import { sharedData, sharedStateText, publishSharedData, withSharedFileTransaction } from "../services/shared-file-transaction";

const audit = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../project-data/audits/release-1.3.5-20260913/ios-worker");

function fixture(run: (journal: string) => void): void {
  fs.mkdirSync(audit, { recursive: true });
  const root = fs.mkdtempSync(audit + "/bootstrap-");
  installNativeSharedFiles(root);
  try { run(root + "/pipi-deliveries/transactions-v1"); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("bootstrap keeps its committed generation after a lost acknowledgement", () => fixture(journal => {
  const nativeLink = FileManager.createLinkSync;
  FileManager.createLinkSync = (p, target) => {
    nativeLink(p, target);
    if (p.endsWith("/start")) throw new Error("synthetic lost bootstrap acknowledgement");
  };
  let calls = 0;
  withSharedFileTransaction(() => { calls++; publishSharedData({}, "first"); });
  FileManager.createLinkSync = nativeLink;
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(fs.readlinkSync(journal + "/start") + "/record.json"));
  assert.equal(sharedStateText(), "first");
  withSharedFileTransaction(() => publishSharedData({}, "second"));
  assert.equal(sharedStateText(), "second");
  assert.equal(sharedStateText(true), "first");
}));

test("a losing bootstrap removes only its proposal and continues from the winning state", () => fixture(journal => {
  const nativeLink = FileManager.createLinkSync;
  let losingProposal = "";
  FileManager.createLinkSync = (p, target) => {
    if (p.endsWith("/start")) {
      losingProposal = target;
      FileManager.createLinkSync = nativeLink;
      // Another initializer publishes between this initializer's preparation and exclusive link.
      withSharedFileTransaction(() => publishSharedData({}, "winner"));
    }
    nativeLink(p, target);
  };
  let calls = 0;
  withSharedFileTransaction(() => {
    calls++;
    assert.equal(sharedStateText(), "winner");
    publishSharedData({ refresh: { completed: true } });
  });
  assert.equal(calls, 1);
  assert.ok(losingProposal);
  assert.equal(fs.existsSync(losingProposal), false);
  assert.ok(fs.existsSync(fs.readlinkSync(journal + "/start") + "/record.json"));
  assert.equal(sharedStateText(), "winner");
  assert.deepEqual(sharedData().refresh, { completed: true });
}));

test("an unreadable bootstrap acknowledgement preserves the proposal for a fresh operation", () => fixture(journal => {
  const nativeLink = FileManager.createLinkSync;
  const nativeTarget = FileManager.destinationOfSymbolicLink;
  const unreadable = new Error("synthetic bootstrap target unavailable");
  let proposal = "";
  FileManager.createLinkSync = (p, target) => {
    nativeLink(p, target);
    if (p.endsWith("/start")) {
      proposal = target;
      throw new Error("synthetic lost bootstrap acknowledgement");
    }
  };
  FileManager.destinationOfSymbolicLink = p => {
    if (proposal && p.endsWith("/start")) throw unreadable;
    return nativeTarget(p);
  };
  let calls = 0;
  assert.throws(() => withSharedFileTransaction(() => { calls++; }), error => error === unreadable);
  assert.equal(calls, 0, "an uncertain initializer cannot run or blindly replay its reducer");
  assert.ok(fs.existsSync(proposal + "/record.json"));
  FileManager.createLinkSync = nativeLink;
  FileManager.destinationOfSymbolicLink = nativeTarget;
  assert.equal(fs.readlinkSync(journal + "/start"), proposal);
  assert.equal(sharedStateText(), null);
  withSharedFileTransaction(() => { calls++; publishSharedData({}, "recovered"); });
  assert.equal(calls, 1);
  assert.equal(sharedStateText(), "recovered");
}));

test("failure before bootstrap publication removes the uncommitted proposal and allows retry", () => fixture(() => {
  const nativeLink = FileManager.createLinkSync;
  const interrupted = new Error("synthetic bootstrap interruption");
  let proposal = "";
  FileManager.createLinkSync = (p, target) => {
    if (p.endsWith("/start")) { proposal = target; throw interrupted; }
    nativeLink(p, target);
  };
  assert.throws(() => withSharedFileTransaction(() => publishSharedData({}, "uncommitted")),
    error => error === interrupted);
  assert.ok(proposal);
  assert.equal(fs.existsSync(proposal), false);
  FileManager.createLinkSync = nativeLink;
  withSharedFileTransaction(() => publishSharedData({}, "retry"));
  assert.equal(sharedStateText(), "retry");
}));
