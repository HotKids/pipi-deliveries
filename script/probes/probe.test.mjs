import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runProbe, readReports } from "./Pipi Concurrency Probe/probe.ts";

const file = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(file), "../../../..");
const temporaryRoot = path.join(repo, "project-data/tmp");
fs.mkdirSync(temporaryRoot, { recursive: true });

function bridge(directory) {
  return {
    appGroupDocumentsDirectory: directory,
    createDirectorySync: (name, recursive = false) => fs.mkdirSync(name, { recursive }),
    writeAsStringSync: (name, value) => fs.writeFileSync(name, value),
    readAsStringSync: (name) => fs.readFileSync(name, "utf8"),
    createLinkSync: (name, target) => fs.symlinkSync(target, name),
    createLink: (name, target) => fs.promises.symlink(target, name),
    destinationOfSymbolicLink: (name) => fs.readlinkSync(name),
    removeSync: (name) => fs.rmSync(name, { recursive: true }),
    existsSync: (name) => fs.existsSync(name),
  };
}

if (process.argv[2] === "child") {
  globalThis.FileManager = bridge(process.argv[3]);
  await new Promise((resolve) => process.once("message", resolve));
  const report = await runProbe(process.argv[4]);
  process.send(report);
  process.disconnect();
} else {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "ios-file-probe-"));
  try {
    globalThis.FileManager = bridge(directory);
    const first = await runProbe("app");
    const second = await runProbe("widget-small");
    assert.equal(first.passed, true);
    assert.equal(second.passed, true);
    assert.equal(first.sharedWinner, second.sharedWinner);
    assert.equal(readReports().length, 2);
    assert.equal(fs.readdirSync(path.join(directory, "pipi-deliveries-concurrency-probe-v1"))
      .some((name) => name.startsWith("check-")), false);

    // The diagnostic must reject a bridge that overwrites an occupied claim.
    globalThis.FileManager = { ...bridge(directory), createLinkSync(name, target) {
      try { fs.unlinkSync(name); } catch {}
      fs.symlinkSync(target, name);
    } };
    const overwrite = await runProbe("app");
    assert.equal(overwrite.passed, false);
    assert.equal(overwrite.checks.duplicateRejected, false);
    assert.equal(overwrite.checks.originalRetained, false);

    globalThis.FileManager = { ...bridge(directory), createLinkSync(name, target) {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      fs.symlinkSync(target, name);
    } };
    const resurrection = await runProbe("app");
    assert.equal(resurrection.passed, false);
    assert.equal(resurrection.checks.retiredParentRejected, false);

    globalThis.FileManager = { appGroupDocumentsDirectory: directory };
    const unavailable = await runProbe("widget-medium");
    assert.equal(unavailable.passed, false);
    assert.equal(unavailable.failedStep, "api");

    // Real local processes exercise the diagnostic together. This is not iPhone evidence.
    fs.rmSync(path.join(directory, "pipi-deliveries-concurrency-probe-v1"), { recursive: true });
    const roles = ["app", "widget-small", "widget-medium"];
    const children = roles.map((host) => spawn(process.execPath,
      ["--no-warnings", "--experimental-transform-types", file, "child", directory, host],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] }));
    const reports = children.map((child) => new Promise((resolve, reject) => {
      let report;
      child.on("message", (value) => { report = value; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 && report ? resolve(report) : reject(new Error("Child failed")));
    }));
    for (const child of children) child.send("start");
    const concurrent = await Promise.all(reports);
    assert.equal(concurrent.every((report) => report.passed), true);
    assert.equal(new Set(concurrent.map((report) => report.sharedWinner)).size, 1);
    console.log("PASS: native-file adapter, negative bridges and three local processes; iPhone unverified");
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}
