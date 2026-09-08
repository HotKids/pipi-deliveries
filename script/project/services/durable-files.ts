import { Path } from "scripting";

const DURABLE_DIRECTORY = "pipi-deliveries";

function durableRoot(): string {
  return Path.join(
    FileManager.appGroupDocumentsDirectory,
    DURABLE_DIRECTORY,
  );
}

function durablePath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error("Invalid durable file name");
  }
  return Path.join(durableRoot(), name);
}

function backupPath(name: string): string {
  return `${durablePath(name)}.backup`;
}

type DurableFileRead = {
  value: string | null;
  failed: boolean;
};

export type DurableTextReadResult = {
  candidates: readonly string[];
  failed: boolean;
};

function readFile(path: string): DurableFileRead {
  try {
    if (!FileManager.existsSync(path)) return { value: null, failed: false };
    if (!FileManager.isFileSync(path)) return { value: null, failed: true };
    return {
      value: FileManager.readAsStringSync(path),
      failed: false,
    };
  } catch {
    return { value: null, failed: true };
  }
}

export function readDurableTextResult(name: string): DurableTextReadResult {
  const reads = [durablePath(name), backupPath(name)].map(readFile);
  return {
    candidates: reads
      .map((read) => read.value)
      .filter((value): value is string => value != null),
    failed: reads.some((read) => read.failed),
  };
}

export function readDurableTextCandidates(name: string): readonly string[] {
  return readDurableTextResult(name).candidates;
}

function removeIfPresent(path: string): void {
  if (FileManager.existsSync(path)) FileManager.removeSync(path);
}

function removeBestEffort(path: string): void {
  try {
    removeIfPresent(path);
  } catch {
    /* cleanup failure must not invalidate an already verified generation */
  }
}

function verifiedText(path: string, value: string): boolean {
  try {
    return FileManager.existsSync(path) &&
      FileManager.isFileSync(path) &&
      FileManager.readAsStringSync(path) === value;
  } catch {
    return false;
  }
}

export function writeDurableText(name: string, value: string): void {
  const root = durableRoot();
  FileManager.createDirectorySync(root, true);
  const path = durablePath(name);
  const backup = backupPath(name);
  const transaction = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const pending = `${path}.pending-${transaction}`;
  const rollback = `${path}.rollback-${transaction}`;
  const backupPending = `${backup}.pending-${transaction}`;
  const backupRollback = `${backup}.rollback-${transaction}`;
  FileManager.writeAsStringSync(pending, value);
  if (!verifiedText(pending, value)) {
    removeIfPresent(pending);
    throw new Error("Durable file verification failed");
  }
  const pathExists = FileManager.existsSync(path);
  if (pathExists && !FileManager.isFileSync(path)) {
    removeBestEffort(pending);
    throw new Error("Durable file path is not a file");
  }
  let currentMoved = false;
  try {
    if (pathExists) {
      FileManager.renameSync(path, rollback);
      currentMoved = true;
    }
    FileManager.renameSync(pending, path);
    if (!verifiedText(path, value)) {
      throw new Error("Durable file verification failed");
    }
  } catch (error) {
    removeBestEffort(pending);
    if (currentMoved) {
      removeBestEffort(path);
      try {
        FileManager.renameSync(rollback, path);
      } catch {
        /* the existing backup remains untouched and recoverable */
      }
    } else if (!pathExists) {
      removeBestEffort(path);
    }
    throw error;
  }

  try {
    FileManager.writeAsStringSync(backupPending, value);
    if (!verifiedText(backupPending, value)) {
      throw new Error("Durable backup verification failed");
    }
    const backupExists = FileManager.existsSync(backup);
    if (backupExists && !FileManager.isFileSync(backup)) {
      throw new Error("Durable backup path is not a file");
    }
    let backupMoved = false;
    try {
      if (backupExists) {
        FileManager.renameSync(backup, backupRollback);
        backupMoved = true;
      }
      FileManager.renameSync(backupPending, backup);
      if (!verifiedText(backup, value)) {
        throw new Error("Durable backup verification failed");
      }
      removeBestEffort(backupRollback);
    } catch (error) {
      removeBestEffort(backupPending);
      if (backupMoved) {
        removeBestEffort(backup);
        try {
          FileManager.renameSync(backupRollback, backup);
        } catch {
          /* the verified primary remains authoritative */
        }
      }
      throw error;
    }
  } catch {
    removeBestEffort(backupPending);
    /* the verified primary remains authoritative */
  }
  removeBestEffort(rollback);
}
