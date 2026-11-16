import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SYNC_SOURCE_FILES = [
  "services/sync/shared.ts",
  "services/sync/route-publications.ts",
  "services/sync/h5-capture.ts",
  "services/sync/jd-order-projection.ts",
  "services/sync/account-list-sync.ts",
  "services/sync/manual-chain-runner.ts",
  "services/sync/cainiao-v5-supplement.ts",
  "services/sync/detail-refresh.ts",
  "services/sync/enrichment-scheduler.ts",
  "services/sync.ts",
] as const;

export function readSyncSource(): string {
  return SYNC_SOURCE_FILES.map((relative) =>
    readFileSync(resolve(projectDir, relative), "utf8")
  ).join("\n\n");
}
