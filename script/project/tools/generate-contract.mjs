#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = resolve(projectDir, "contracts/express-policy.v1.json");
const outputPath = resolve(projectDir, "contracts/express-policy.generated.ts");
const policy = JSON.parse(await readFile(jsonPath, "utf8"));
const generated = [
  "// Generated from express-policy.v1.json. Run tools/generate-contract.mjs after editing the JSON.",
  `export const EXPRESS_POLICY = ${JSON.stringify(policy, null, 2)} as const;`,
  "",
  "export type ExpressPolicy = typeof EXPRESS_POLICY;",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    throw new Error("express-policy.generated.ts is out of date");
  }
} else {
  await writeFile(outputPath, generated);
}
