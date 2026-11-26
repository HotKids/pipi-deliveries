import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// G-LOW-14 (2026-11-20 review).
// 1. The package verifier requires every script entry the host starts, notification.tsx included.
// 2. Host globals are never imported from "scripting": `import { Dialog } from "scripting"` yields undefined on the
//    phone (AGENTS §9, Scripting host globals), the reverse of AppEvents (app-events-import.test.ts). The names are the
//    globals this project already calls on the phone without an import.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = readFileSync(join(projectRoot, "tools/verify-package.sh"), "utf8");
const required = verifier.match(/for required in \\\n([\s\S]*?)\ndo\n/)?.[1].split("\\\n").map(line => line.trim())
  .filter(Boolean) ?? [];
assert.ok(required.length > 20, "the required list was found");
const packageFiles = readFileSync(join(projectRoot, "tools/package-files.py"), "utf8");
const entries = [...(packageFiles.match(/IOS_FILES = \{([^}]*)\}/)?.[1] ?? "").matchAll(/"([^"]+\.tsx)"/g)]
  .map(match => match[1]!);
assert.ok(entries.includes("notification.tsx"));
for (const entry of entries) assert.ok(required.includes(entry), `verify-package.sh requires ${entry}`);

const HOST_GLOBALS = ["Animation", "Clipboard", "Crypto", "Data", "Device", "Dialog", "FileManager", "ImageIO",
  "Keyboard", "Keychain", "Pasteboard", "QRCode", "Safari", "Storage", "Transition", "UIGlass", "UIImage", "UUID",
  "Vision"] as const;

function scriptingValueImports(source: string): string[] {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']scripting["']/g)].flatMap(match => match[1]!.split(","))
    .map(entry => entry.trim()).filter(name => name && !name.startsWith("type "))
    .map(name => name.split(/\s+as\s+/)[0]!.trim());
}
function misimported(source: string): string[] {
  const names = new Set<string>(HOST_GLOBALS);
  return scriptingValueImports(source).filter(name => names.has(name));
}
assert.deepEqual(misimported('import { Dialog, List, type VirtualNode } from "scripting";'), ["Dialog"],
  "the guard sees a host global in a scripting import");
assert.deepEqual(misimported('import { Navigation, Script } from "scripting";'), []);

const skipped = new Set(["tests", "tools", "assets", "node_modules", "probes"]);
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return skipped.has(name) ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const used = new Set<string>();
for (const path of sources(projectRoot)) {
  const source = readFileSync(path, "utf8");
  assert.deepEqual(misimported(source), [], `${relative(projectRoot, path)} imports a host global from "scripting"`);
  for (const name of HOST_GLOBALS) if (new RegExp(`(?<![\\w.$])${name}\\.`).test(source)) used.add(name);
}
assert.deepEqual([...used].sort(), [...HOST_GLOBALS].sort(), "every listed global is one the project uses");
console.log("package entries and host globals passed");
