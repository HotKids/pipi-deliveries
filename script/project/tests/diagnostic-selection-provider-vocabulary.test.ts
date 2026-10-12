import assert from "node:assert/strict";

const memory = new Map<string, unknown>();
Object.assign(globalThis, {
  Storage: {
    get<T>(key: string): T | null { return (memory.get(key) as T | undefined) ?? null; },
    set(key: string, value: unknown): boolean { memory.set(key, structuredClone(value)); return true; },
    remove(key: string): void { memory.delete(key); },
  },
});
const { readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } = await import("../services/logger");

// Audit R10 (adopted 2026-09-25): every diagnostic field uses the 2026-09-05 log vocabulary. The
// selection evidence fields named internal package ids (interface5, kuaidi100_h5, account).
setDiagnosticsEnabled(true);
writeDiagnostic("detail.timeline.selected", {
  historyProvider: "interface5",
  headlineProvider: "kuaidi100_h5",
  statusProvider: "account",
  selectionReason: "only_eligible_history",
});
writeDiagnostic("detail.timeline.selected", {
  historyProvider: "v5_query",
  headlineProvider: "attached_carrier",
  statusProvider: "none",
});
const [second, first] = readDiagnostics();
assert.equal(first.details.historyProvider, "v5_list");
assert.equal(first.details.headlineProvider, "k100_h5");
assert.equal(first.details.statusProvider, "v5_list");
// Values outside the package vocabulary pass through unchanged.
assert.equal(second.details.historyProvider, "v5_query");
assert.equal(second.details.headlineProvider, "attached_carrier");
assert.equal(second.details.statusProvider, "none");

console.log("diagnostic selection provider vocabulary tests passed");
