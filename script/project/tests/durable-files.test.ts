import assert from "node:assert/strict";
import test from "node:test";
import { memory } from "./state-storage-mock";
import { readDurableTextCandidates, readDurableTextResult, writeDurableText } from "../services/durable-files";

const PRIMARY = "/group/pipi-deliveries/state.json";
const original = {
  write: FileManager.writeAsStringSync,
  exists: FileManager.existsSync,
  isFile: FileManager.isFileSync,
  remove: FileManager.removeSync,
};

function restore() {
  Object.assign(FileManager, { writeAsStringSync: original.write, existsSync: original.exists,
    isFileSync: original.isFile, removeSync: original.remove });
}

function seed() {
  restore();
  memory.clear();
  writeDurableText("state.json", "committed-generation");
}

function assertCommitted() {
  assert.deepEqual(readDurableTextResult("state.json"), {
    candidates: ["committed-generation", "committed-generation"], failed: false,
  });
  assert.deepEqual(readDurableTextCandidates("state.json"),
    ["committed-generation", "committed-generation"]);
}

test("successful writes retain the Deliveries directory and both readable generations", () => {
  seed();
  assert.equal(memory.get(`file:${PRIMARY}`), "committed-generation");
  assert.equal(memory.get(`file:${PRIMARY}.backup`), "committed-generation");
  assertCommitted();
});

for (const phase of ["partial_write", "path_exists", "path_type"] as const) {
  test(`${phase} failure removes only the uncommitted staging file and preserves the error`, () => {
    seed();
    const failure = new Error(`injected ${phase}`);
    Object.assign(FileManager, {
      writeAsStringSync(path: string, value: string) {
        original.write(path, value);
        if (phase === "partial_write" && path.includes(".pending-")) throw failure;
      },
      existsSync(path: string) {
        if (phase === "path_exists" && path === PRIMARY) throw failure;
        return original.exists(path);
      },
      isFileSync(path: string) {
        if (phase === "path_type" && path === PRIMARY) throw failure;
        return original.isFile(path);
      },
    });
    try {
      assert.throws(() => writeDurableText("state.json", "uncommitted-generation"), error => error === failure);
    } finally { restore(); }
    assert.equal([...memory.keys()].some(key => key.includes(".pending-")), false);
    assertCommitted();
  });
}

test("a cleanup failure cannot replace the original staging-write error or change committed data", () => {
  seed();
  const failure = new Error("injected staging write");
  Object.assign(FileManager, {
    writeAsStringSync(path: string, value: string) {
      original.write(path, value);
      if (path.includes(".pending-")) throw failure;
    },
    removeSync() { throw new Error("injected cleanup failure"); },
  });
  try {
    assert.throws(() => writeDurableText("state.json", "uncommitted-generation"), error => error === failure);
  } finally { restore(); }
  assertCommitted();
});
