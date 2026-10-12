import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Device evidence 2026-09-24: `AppEvents` is not a host global. It is declared inside and exported
// from the "scripting" module (app-synced scripting.d.ts; global.d.ts has no AppEvents), so a bare
// `AppEvents.scenePhase.addListener(...)` threw `ReferenceError: Can't find variable: AppEvents`
// inside the effect on the phone and no scene change was ever observed. Node tests stub globals and
// never load index.tsx, so only a source check can catch the missing import.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipped = new Set(["tests", "tools", "assets", "node_modules"]);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return skipped.has(name) ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function scriptingValueImports(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']scripting["']/g)) {
    for (const entry of match[1].split(",")) {
      const name = entry.trim();
      if (!name || name.startsWith("type ")) continue;
      names.add(name.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

const users = sources(projectRoot).filter((path) => /\bAppEvents\s*\./.test(readFileSync(path, "utf8")));
assert.ok(
  users.some((path) => relative(projectRoot, path) === "index.tsx"),
  "the app root observes the scene phase",
);
for (const path of users) {
  assert.ok(
    scriptingValueImports(readFileSync(path, "utf8")).has("AppEvents"),
    `${relative(projectRoot, path)} uses AppEvents without importing it from "scripting"`,
  );
}

console.log("AppEvents import contract passed");
