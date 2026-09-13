import { writeDiagnostic } from "./logger";
import { utf8Data } from "./scripting-data";

type SharedData = { refresh?: unknown; stateRef?: string; previousStateRef?: string };
type Frame = { id: string; sequence: number; data: SharedData };
const DIRECTORY = "pipi-deliveries/transactions-v1";
const ID = /^g(\d+)-[a-z0-9]+$/;
const MAX_ATTEMPTS = 8;
let active: Frame | undefined;

export class SharedCommitConflict extends Error {
  constructor() { super("Shared state changed during commit"); this.name = "SharedCommitConflict"; }
}
export class SharedCommitOutcomeUnknown extends Error {
  constructor() { super("Shared commit acknowledgement was lost; reload before retrying"); this.name = "SharedCommitOutcomeUnknown"; }
}

function root(): string { return `${FileManager.appGroupDocumentsDirectory}/${DIRECTORY}`; }
function path(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid shared generation");
  return `${root()}/${id}`;
}
function hash(value: string): string { return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase(); }
function writeVerified(name: string, text: string): void {
  FileManager.writeAsStringSync(name, text);
  if (FileManager.readAsStringSync(name) !== text) throw new Error("Shared file verification failed");
}
function linkTarget(name: string): string | null {
  try { return FileManager.destinationOfSymbolicLink(name); }
  catch (error) {
    if (FileManager.isLinkSync(name) || FileManager.existsSync(name)) throw error;
    return null;
  }
}
function linkedId(name: string): string | null {
  const target = linkTarget(name);
  if (target == null) return null;
  const id = target.slice(root().length + 1);
  if (target !== path(id)) throw new Error("Invalid shared pointer");
  return id;
}
function readFrame(id: string): Frame {
  const envelope = JSON.parse(FileManager.readAsStringSync(`${path(id)}/record.json`));
  if (typeof envelope?.payload !== "string" || hash(envelope.payload) !== envelope.checksum) {
    throw new Error("Invalid shared record checksum");
  }
  const frame = JSON.parse(envelope.payload);
  if (frame?.id !== id || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
      Number(ID.exec(id)?.[1]) !== frame.sequence || !frame.data || typeof frame.data !== "object") {
    throw new Error("Invalid shared record");
  }
  return frame;
}
function prepare(sequence: number, data: SharedData, blob?: string): Frame {
  const id = `g${sequence}-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  FileManager.createDirectorySync(path(id), false);
  const frame: Frame = { id, sequence, data: { ...data } };
  try {
    if (blob != null) {
      writeVerified(`${path(id)}/state.json`, blob);
      frame.data.previousStateRef = data.stateRef;
      frame.data.stateRef = id;
    }
    const payload = JSON.stringify(frame);
    writeVerified(`${path(id)}/record.json`, JSON.stringify({ payload, checksum: hash(payload) }));
    return frame;
  } catch (error) {
    removeBestEffort(path(id));
    throw error;
  }
}
function publishHint(frame: Frame): void {
  const hint = `${root()}/head-${frame.sequence}`;
  try { FileManager.createLinkSync(hint, path(frame.id)); }
  catch (error) { if (linkedId(hint) !== frame.id) throw error; }
}
function removeBestEffort(name: string): void {
  try { FileManager.removeSync(name); } catch { /* A committed generation remains readable. */ }
}
function entries(): string[] {
  return FileManager.readDirectorySync(root(), false).map((name) => name.split("/").pop()!);
}

function latest(): Frame {
  FileManager.createDirectorySync(root(), true);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const hints = entries().filter((name) => /^head-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    let id = linkedId(`${root()}/${hints[0] || "start"}`);
    if (!id) {
      if (hints.length) continue;
      const first = prepare(0, {});
      try { FileManager.createLinkSync(`${root()}/start`, path(first.id)); id = first.id; }
      catch (error) {
        // The native call may have published start before losing its acknowledgement.
        id = linkedId(`${root()}/start`);
        if (id !== first.id) removeBestEffort(path(first.id));
        if (!id) throw error;
      }
    }
    try {
      let frame = readFrame(id);
      for (let depth = 0; depth < 256; depth++) {
        const next = linkedId(`${path(frame.id)}/next`);
        if (!next) { publishHint(frame); return frame; }
        const successor = readFrame(next);
        if (successor.sequence !== frame.sequence + 1) throw new Error("Invalid shared sequence");
        frame = successor;
      }
      throw new Error("Shared journal traversal limit");
    } catch (error) {
      // A reader can race retirement of an older hint; never treat corruption as an empty store.
      const newest = entries().filter((name) => /^head-\d+$/.test(name))
        .some((name) => Number(name.slice(5)) > Number(ID.exec(id)?.[1]));
      if (!newest || attempt === MAX_ATTEMPTS - 1) throw error;
    }
  }
  throw new SharedCommitConflict();
}

function retire(frame: Frame): void {
  // Retire complete parent directories, never just their next links: stale publishers must
  // fail in a missing parent rather than recreate a previously occupied publication slot.
  const keep = new Set([frame.id, frame.data.stateRef, frame.data.previousStateRef]);
  for (const name of entries()) {
    const generation = ID.exec(name);
    if (generation && Number(generation[1]) < frame.sequence - 2 && !keep.has(name)) {
      removeBestEffort(path(name));
    }
  }
  for (const name of entries()) {
    if (/^head-\d+$/.test(name) && Number(name.slice(5)) < frame.sequence - 2) {
      removeBestEffort(`${root()}/${name}`);
    }
  }
}

export function sharedCommitSequence(): number { return (active || latest()).sequence; }
export function sharedData(): Readonly<SharedData> { return (active || latest()).data; }
export function sharedStateText(previous = false): string | null {
  const data = sharedData();
  const id = previous ? data.previousStateRef : data.stateRef;
  if (!id) return null;
  try { return FileManager.readAsStringSync(`${path(id)}/state.json`); }
  catch (error) {
    if (active && latest().id !== active.id) throw new SharedCommitConflict();
    throw error;
  }
}

export function publishSharedData(patch: Partial<SharedData>, stateText?: string): void {
  if (!active) throw new Error("Shared publication requires a transaction");
  const base = active;
  let next: Frame;
  try { next = prepare(base.sequence + 1, { ...base.data, ...patch }, stateText); }
  catch (error) {
    if (latest().id !== base.id) throw new SharedCommitConflict();
    throw error;
  }
  try {
    FileManager.createLinkSync(`${path(base.id)}/next`, path(next.id));
  } catch (error) {
    // A failed response after successful publication must not turn a committed mutation
    // into a retry. Only discard a proposal whose slot is known to belong elsewhere.
    const winner = linkedId(`${path(base.id)}/next`);
    if (winner !== next.id) {
      if (!winner && latest().id !== base.id) {
        // Retirement can erase the acknowledgement after this proposal won. It may
        // still hold the current state blob: preserve it and never replay blindly.
        writeDiagnostic("storage.transaction.uncertain", {
          commitProtocol: "immutable_link", commitSequence: base.sequence,
          result: "acknowledgement_unknown",
        }, "warning");
        throw new SharedCommitOutcomeUnknown();
      }
      removeBestEffort(path(next.id));
      if (winner) throw new SharedCommitConflict();
      throw error;
    }
  }
  active = next;
  try { publishHint(next); retire(next); } catch { /* The committed next link permits recovery. */ }
}

export function withSharedFileTransaction<T>(operation: () => T): T {
  if (active) return operation();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    active = latest();
    try { return operation(); }
    catch (error) {
      if (!(error instanceof SharedCommitConflict) || attempt === MAX_ATTEMPTS - 1) throw error;
      writeDiagnostic("storage.transaction.retry", {
        commitProtocol: "immutable_link", commitSequence: active.sequence,
        attempted: attempt + 1, result: "generation_conflict",
      });
    } finally { active = undefined; }
  }
  throw new SharedCommitConflict();
}
