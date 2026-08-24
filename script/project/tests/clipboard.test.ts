import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyText } from "../services/clipboard.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../script.json", import.meta.url), "utf8"),
);
assert.equal(manifest.permissions, null);
const clipboardSource = readFileSync(
  new URL("../services/clipboard.ts", import.meta.url),
  "utf8",
);
assert.equal(
  clipboardSource.includes("requestAccess"),
  false,
  "copying must not proactively open Scripting's permission sheet",
);

let modernWrites: string[] = [];
let itemWrites: Array<Record<string, string>[]> = [];
let legacyWrites: string[] = [];
let permissionRequests: string[][] = [];

function reset() {
  modernWrites = [];
  itemWrites = [];
  legacyWrites = [];
  permissionRequests = [];
}

globalThis.Script = {
  async requestAccess(apis: string[]) {
    permissionRequests.push(apis);
    return ["clipboard"];
  },
};
globalThis.Pasteboard = {
  async setString(value: string) {
    modernWrites.push(value);
  },
  async setItems(items: Array<Record<string, string>>) {
    itemWrites.push(items);
  },
};
globalThis.Clipboard = {
  copyText(value: string) {
    legacyWrites.push(value);
  },
};

reset();
assert.equal(await copyText("  JD012345  "), "copied");
assert.deepEqual(permissionRequests, []);
assert.deepEqual(modernWrites, ["JD012345"]);
assert.deepEqual(itemWrites, []);
assert.deepEqual(legacyWrites, []);

reset();
globalThis.Pasteboard.setString = async () => {
  throw new Error("unavailable");
};
assert.equal(await copyText("JD67890"), "copied");
assert.deepEqual(permissionRequests, []);
assert.deepEqual(itemWrites, [[{ "public.plain-text": "JD67890" }]]);
assert.deepEqual(legacyWrites, []);

reset();
globalThis.Pasteboard.setItems = async () => {
  throw new Error("unavailable");
};
assert.equal(await copyText("JD24680"), "copied");
assert.deepEqual(permissionRequests, []);
assert.deepEqual(legacyWrites, ["JD24680"]);

reset();
globalThis.Clipboard.copyText = () => {
  throw new Error("unavailable");
};
assert.equal(await copyText("JD99999"), "failed");
assert.deepEqual(permissionRequests, []);

reset();
globalThis.Script.requestAccess = async (apis: string[]) => {
  permissionRequests.push(apis);
  return [];
};
assert.equal(await copyText("JD00001"), "failed");
assert.deepEqual(permissionRequests, []);
assert.deepEqual(modernWrites, []);
assert.deepEqual(legacyWrites, []);

reset();
globalThis.Script.requestAccess = async () => {
  throw new Error("unsupported");
};
globalThis.Pasteboard.setString = async (value: string) => {
  modernWrites.push(value);
};
assert.equal(await copyText("JD00002"), "copied");
assert.deepEqual(modernWrites, ["JD00002"]);
assert.deepEqual(permissionRequests, []);

reset();
globalThis.Pasteboard.setString = async () => {
  throw new Error("unavailable");
};
globalThis.Pasteboard.setItems = async () => {
  throw new Error("unavailable");
};
assert.equal(await copyText("JD00003"), "failed");
assert.deepEqual(permissionRequests, []);

reset();
assert.equal(await copyText("   "), "failed");
assert.deepEqual(permissionRequests, []);
assert.deepEqual(modernWrites, []);
assert.deepEqual(legacyWrites, []);

console.log("clipboard compatibility tests passed");
