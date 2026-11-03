import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installNativeSharedFiles } from "./shared-file-native";
import { sharedCommitSequence, sharedData, sharedStateText, publishSharedData,
  withSharedFileTransaction } from "../services/shared-file-transaction";

const audit = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../project-data/audits/20261103-ios-refresh-lag");
const generation = /^g(\d+)-[a-z0-9]+$/;

function fixture(run: (journal: string) => void): void {
  fs.mkdirSync(audit, { recursive: true });
  const root = fs.mkdtempSync(audit + "/retirement-");
  installNativeSharedFiles(root);
  try {
    withSharedFileTransaction(() => publishSharedData({}, "first state"));
    withSharedFileTransaction(() => publishSharedData({}, "second state"));
    for (let counter = 3; counter <= 5; counter++)
      withSharedFileTransaction(() => publishSharedData({ refresh: { counter } }));
    run(root + "/pipi-deliveries/transactions-v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a shared publication lists the retirement directory only once", () => fixture(() => {
  const nativeRead = FileManager.readDirectorySync;
  let totalLists = 0, retirementLists = 0;
  let publishing = false;
  FileManager.readDirectorySync = (name, recursive) => {
    totalLists++;
    if (publishing) retirementLists++;
    return nativeRead(name, recursive);
  };
  try {
    withSharedFileTransaction(() => {
      publishing = true;
      publishSharedData({ refresh: { counter: 6 } });
      publishing = false;
    });
    console.log("SHARED_FILE_RETIRE_CALLS", JSON.stringify({ retirementLists, totalLists }));
    assert.equal(retirementLists, 1, "one snapshot serves generation and head retirement");
    assert.equal(totalLists, 2, "latest discovery and retirement each retain their own snapshot");
  } finally { FileManager.readDirectorySync = nativeRead; }
}));

test("retirement preserves state pins, thresholds, unrelated entries and generation-before-head order", () => fixture(journal => {
  const nativeRead = FileManager.readDirectorySync, nativeRemove = FileManager.removeSync;
  const removed: string[] = [];
  let snapshot: string[] = [];
  let publishing = false;
  for (const name of ["unrelated", "g3-invalid_name", "head-note"])
    fs.writeFileSync(`${journal}/${name}`, "synthetic unrelated entry");
  FileManager.readDirectorySync = (name, recursive) => {
    const names = nativeRead(name, recursive).reverse();
    if (publishing && !snapshot.length) snapshot = names;
    return names;
  };
  FileManager.removeSync = name => { removed.push(path.basename(name)); nativeRemove(name); };
  try {
    let sequence = 0;
    let pins = new Set<string | undefined>();
    withSharedFileTransaction(() => {
      publishing = true;
      publishSharedData({ refresh: { counter: 6 } });
      sequence = sharedCommitSequence();
      pins = new Set([sharedData().stateRef, sharedData().previousStateRef,
        path.basename(fs.readlinkSync(`${journal}/head-${sequence}`))]);
      publishing = false;
    });
    assert.equal(sequence, 6);
    const oldGeneration = snapshot.find(name => name.startsWith("g3-"));
    const boundaryGeneration = snapshot.find(name => name.startsWith("g4-"));
    assert.ok(oldGeneration && boundaryGeneration);
    assert.deepEqual(removed, [oldGeneration, "head-3"]);
    assert.ok(fs.existsSync(`${journal}/${boundaryGeneration}`));
    assert.ok(fs.existsSync(`${journal}/head-4`));
    assert.equal(sharedStateText(), "second state");
    assert.equal(sharedStateText(true), "first state");
    for (const name of pins) assert.ok(fs.existsSync(`${journal}/${name}`));
    for (const name of ["unrelated", "g3-invalid_name", "head-note"])
      assert.equal(fs.readFileSync(`${journal}/${name}`, "utf8"), "synthetic unrelated entry");
    assert.ok(fs.readdirSync(journal).filter(name => generation.test(name)).length <= 5);
  } finally { FileManager.readDirectorySync = nativeRead; FileManager.removeSync = nativeRemove; }
}));

test("a failed generation removal does not fail or replay the committed reducer", () => fixture(journal => {
  const nativeRemove = FileManager.removeSync;
  let failed = "", reducers = 0;
  FileManager.removeSync = name => {
    if (/^g3-/.test(path.basename(name))) {
      failed = name;
      throw new Error("synthetic removal unavailable");
    }
    nativeRemove(name);
  };
  try {
    withSharedFileTransaction(() => { reducers++; publishSharedData({ refresh: { counter: 6 } }); });
    assert.equal(reducers, 1);
    assert.equal((sharedData().refresh as { counter: number }).counter, 6);
    assert.equal(sharedStateText(), "second state");
    assert.equal(sharedStateText(true), "first state");
    assert.ok(failed && fs.existsSync(failed));
    assert.equal(fs.existsSync(`${journal}/head-3`), false, "head cleanup still follows failed generation cleanup");
    FileManager.removeSync = nativeRemove;
    withSharedFileTransaction(() => publishSharedData({ refresh: { counter: 7 } }));
    assert.equal(fs.existsSync(failed), false);
  } finally { FileManager.removeSync = nativeRemove; }
}));

test("a late old hint cannot change the committed state and is retired by a subsequent publication", () => fixture(journal => {
  const nativeRemove = FileManager.removeSync;
  const pinned = sharedData().previousStateRef!;
  let injected = false;
  FileManager.removeSync = name => {
    nativeRemove(name);
    if (!injected && /^g3-/.test(path.basename(name))) {
      injected = true;
      fs.symlinkSync(`${journal}/${pinned}`, `${journal}/head-1`);
    }
  };
  try {
    withSharedFileTransaction(() => publishSharedData({ refresh: { counter: 6 } }));
    assert.equal(injected, true);
    assert.equal(sharedStateText(), "second state");
    assert.equal(sharedStateText(true), "first state");
    assert.equal((sharedData().refresh as { counter: number }).counter, 6);
    FileManager.removeSync = nativeRemove;
    withSharedFileTransaction(() => publishSharedData({ refresh: { counter: 7 } }));
    assert.equal(fs.existsSync(`${journal}/head-1`), false);
    assert.equal(sharedStateText(), "second state");
    assert.equal(sharedStateText(true), "first state");
  } finally { FileManager.removeSync = nativeRemove; }
}));
