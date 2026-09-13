export type ProbeHost = "app" | "widget-small" | "widget-medium";
export type ProbeReport = {
  version: 1;
  host: ProbeHost;
  atMs: number;
  checks: Record<string, boolean>;
  failedStep?: string;
  sharedWinner?: ProbeHost;
  passed: boolean;
};

const HOSTS: ProbeHost[] = ["app", "widget-small", "widget-medium"];
const DIRECTORY = "pipi-deliveries-concurrency-probe-v1";

function root(): string {
  return `${FileManager.appGroupDocumentsDirectory}/${DIRECTORY}`;
}

function rejected(action: () => void): boolean {
  try { action(); return false; } catch { return true; }
}

export async function runProbe(host: ProbeHost): Promise<ProbeReport> {
  const report: ProbeReport = {
    version: 1, host, atMs: Date.now(), checks: {}, passed: false,
  };
  let workspace: string | undefined;
  let step = "api";
  try {
    const methods = ["createDirectorySync", "writeAsStringSync", "readAsStringSync",
      "createLink", "createLinkSync", "destinationOfSymbolicLink", "removeSync", "existsSync"];
    report.checks.api = typeof FileManager.appGroupDocumentsDirectory === "string" &&
      methods.every((name) => typeof (FileManager as unknown as Record<string, unknown>)[name] === "function");
    if (!report.checks.api) throw new Error("Unavailable bridge");

    step = "prepare";
    FileManager.createDirectorySync(root(), true);
    workspace = `${root()}/check-${host}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    FileManager.createDirectorySync(workspace, false);
    const first = `${workspace}/first.txt`;
    const second = `${workspace}/second.txt`;
    const claim = `${workspace}/claim`;
    FileManager.writeAsStringSync(first, "synthetic-first");
    FileManager.writeAsStringSync(second, "synthetic-second");

    step = "publish";
    FileManager.createLinkSync(claim, first);
    report.checks.publish = FileManager.destinationOfSymbolicLink(claim) === first &&
      FileManager.readAsStringSync(claim) === "synthetic-first";

    step = "duplicate";
    report.checks.duplicateRejected = rejected(() => FileManager.createLinkSync(claim, second));
    report.checks.originalRetained = FileManager.destinationOfSymbolicLink(claim) === first &&
      FileManager.readAsStringSync(claim) === "synthetic-first";

    step = "concurrent_create";
    const race = `${workspace}/race`;
    const pendingAttempts = Promise.all(Array.from({ length: 8 }, (_, index) => {
      const target = index % 2 === 0 ? first : second;
      return FileManager.createLink(race, target).then(
        () => ({ won: true, target }), () => ({ won: false, target }));
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempts = await Promise.race([
      pendingAttempts,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Probe deadline")), 3_000);
      }),
    ]).finally(() => { if (timer != null) clearTimeout(timer); });
    const winners = attempts.filter((attempt) => attempt.won);
    report.checks.concurrentCreate = winners.length === 1 &&
      FileManager.destinationOfSymbolicLink(race) === winners[0].target;

    step = "existing_file";
    report.checks.fileRejected = rejected(() => FileManager.createLinkSync(first, second)) &&
      FileManager.readAsStringSync(first) === "synthetic-first";

    step = "unlink";
    FileManager.removeSync(claim);
    report.checks.targetRetained = FileManager.readAsStringSync(first) === "synthetic-first";
    FileManager.createLinkSync(claim, second);
    report.checks.recreate = FileManager.readAsStringSync(claim) === "synthetic-second";

    step = "retired_parent";
    const retired = `${workspace}/retired`;
    FileManager.createDirectorySync(retired, false);
    FileManager.removeSync(retired);
    report.checks.retiredParentRejected = rejected(() =>
      FileManager.createLinkSync(`${retired}/next`, first)) && !FileManager.existsSync(retired);

    step = "shared_witness";
    // This permanent witness tests cross-host visibility, not simultaneous arbitration.
    const target = `${root()}/${host}-witness.txt`;
    FileManager.writeAsStringSync(target, host);
    const witness = `${root()}/shared-witness`;
    const created = !rejected(() => FileManager.createLinkSync(witness, target));
    const winnerPath = FileManager.destinationOfSymbolicLink(witness);
    const winner = HOSTS.find((item) => winnerPath === `${root()}/${item}-witness.txt`);
    report.sharedWinner = winner;
    report.checks.sharedWitness = winner != null &&
      FileManager.readAsStringSync(witness) === winner && (!created || winner === host);
    report.passed = Object.values(report.checks).every(Boolean);
  } catch {
    report.failedStep = step;
  } finally {
    if (workspace) {
      // Only this invocation's synthetic workspace is removed.
      try { FileManager.removeSync(workspace); } catch { report.checks.cleanup = false; }
    }
  }
  if (report.checks.cleanup === false) report.passed = false;
  try {
    FileManager.writeAsStringSync(`${root()}/${host}-report.json`, JSON.stringify(report));
  } catch {
    report.checks.reportSaved = false;
    report.passed = false;
  }
  console.log(`pipi.atomic.probe ${JSON.stringify(report)}`);
  return report;
}

export function readReports(): ProbeReport[] {
  return HOSTS.flatMap((host) => {
    try {
      const value = JSON.parse(FileManager.readAsStringSync(`${root()}/${host}-report.json`));
      return value?.version === 1 && value.host === host && typeof value.passed === "boolean" &&
          value.checks && typeof value.checks === "object" ? [value as ProbeReport] : [];
    } catch { return []; }
  });
}

export function reportLines(report: ProbeReport): string[] {
  return [
    `${report.host}: ${report.passed ? "CHECKS PASSED" : "CHECK FAILED"}`,
    new Date(report.atMs).toISOString(),
    ...Object.entries(report.checks).map(([key, value]) => `${key}: ${value ? "PASS" : "FAIL"}`),
    ...(report.failedStep ? [`Stopped at: ${report.failedStep}`] : []),
    `Shared witness: ${report.sharedWinner || "unavailable"}`,
  ];
}
