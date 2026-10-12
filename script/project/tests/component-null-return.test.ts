import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Device evidence 2026-09-24 (scripting-cli live console, iOS beta68): SenderBadge returned null on
// every row that is not a sender row, and each such row logged `Failed to build component.
// TypeError: null is not an object (evaluating 'e.isInternal')`. Scripting's FunctionComponent must
// return a VirtualNode (app-synced scripting.d.ts); to render nothing, the call site leaves the
// component out with `{cond ? <X /> : null}`, a child value the renderer skips. Node tests cannot
// render TSX, so only a source check can catch a component that returns null or undefined.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipped = new Set(["tests", "tools", "assets", "node_modules"]);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return skipped.has(name) ? [] : sources(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

const indent = (line: string) => line.length - line.trimStart().length;

// The line without string contents and trailing comment, so quoted text cannot look like code.
function code(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\/\/.*$/, "")
    .trimEnd();
}

// Relies on the project's formatting: a block closes on a line at the indent it opened on, and a
// signature split over several lines ends with `) {` or `): Type {` at the indent it started on.
function opensNestedFunction(lines: string[], index: number): boolean {
  const line = code(lines[index]);
  if (!line.endsWith("{")) return false;
  if (/=>\s*\{$/.test(line) || /\bfunction\b/.test(line)) return true;
  if (!/^\s*\)/.test(line)) return false;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (!lines[previous].trim() || indent(lines[previous]) !== indent(lines[index])) continue;
    return !/^\s*(\}\s*else\s+)?(if|for|while|switch)\b/.test(lines[previous]);
  }
  return false;
}

// The component's own lines: handlers and callbacks nested in it may return nothing.
function ownLines(lines: string[], from: number, to: number): string[] {
  const own: string[] = [];
  for (let index = from; index < to; index += 1) {
    if (!opensNestedFunction(lines, index)) {
      own.push(lines[index]);
      continue;
    }
    const depth = indent(lines[index]);
    while (index + 1 < to && !(indent(lines[index + 1]) === depth && lines[index + 1].trimStart().startsWith("}"))) {
      index += 1;
    }
    index += 1;
  }
  return own;
}

function returnsNothing(own: string[], index: number): boolean {
  const line = code(own[index]).replace(/(=>|\bfunction\b[^{]*)\s*\{.*\}/g, "");
  if (/\breturn\s*(null|undefined)?\s*(;|$)/.test(line)) return true;
  if (!/[?:]\s*(null|undefined)\s*;?$/.test(line)) return false;
  // A conditional whose other branch is null: `return shown ? <X /> : null;`, the closing `) : null;`
  // of `return shown ? (`, or a `: null` continuation line under `return shown`.
  if (/\breturn\b/.test(line)) return true;
  const depth = indent(own[index]);
  const closing = /^\s*[)\]}]/.test(line);
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (!own[previous].trim()) continue;
    const at = indent(own[previous]);
    if (at > depth || (!closing && at === depth)) continue;
    return (!closing || at === depth) && /^\s*return\b/.test(code(own[previous]));
  }
  return false;
}

function componentsReturningNothing(source: string, scanned: string[] = []): string[] {
  const lines = source.split("\n");
  const found: string[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const name = /^(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*)/.exec(lines[start])?.[1];
    if (!name) continue;
    let open = start;
    while (open < lines.length && !/\)\s*(?::[^=]*)?\{$/.test(code(lines[open]))) open += 1;
    let close = open + 1;
    while (close < lines.length && !lines[close].startsWith("}")) close += 1;
    const own = ownLines(lines, open + 1, close);
    own.forEach((line, index) => {
      if (returnsNothing(own, index)) found.push(`${name}: ${line.trim()}`);
    });
    scanned.push(name);
    start = close;
  }
  return found;
}

// The shape found on the phone is caught; handler returns and null children are not.
assert.deepEqual(
  componentsReturningNothing(`export function Before(props: { sender?: boolean }) {
  if (props.sender !== true) return null;
  return <Text>寄</Text>;
}
export function Handlers(props: {
  shown: boolean;
}) {
  async function query() {
    if (busy) return;
  }
  const refresh = async () => {
    return undefined;
  };
  if (!props.shown) {
    return <Text>early</Text>;
  }
  const note = props.shown ? (
    <Text>note</Text>
  ) : null;
  return (
    <VStack>
      {props.shown ? <Text>x</Text> : null}
      <Button action={() => { return; }} />
    </VStack>
  );
}
export function Conditional(props: { shown: boolean }) {
  if (props.shown) {
    return undefined;
  }
  return props.shown ? (
    <Text>x</Text>
  ) : null;
}`),
  [
    "Before: if (props.sender !== true) return null;",
    "Conditional: return undefined;",
    "Conditional: ) : null;",
  ],
);

const scanned: string[] = [];
for (const path of sources(projectRoot)) {
  const found = componentsReturningNothing(readFileSync(path, "utf8"), scanned);
  assert.deepEqual(found, [], `${relative(projectRoot, path)} has a component that returns nothing`);
}
for (const name of ["SenderBadge", "ShipmentRow", "HomePage", "DetailPage", "MediumWidget"]) {
  assert.ok(scanned.includes(name), `${name} was scanned`);
}

console.log(`Component return contract passed (${scanned.length} components)`);
