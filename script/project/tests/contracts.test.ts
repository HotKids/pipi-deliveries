import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shipment, StatusSemantic, TrackNode } from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(
  await readFile(resolve(projectDir, "contracts/express-policy.v1.json"), "utf8"),
);
assert.deepEqual(EXPRESS_POLICY, policy);
assert.equal(EXPRESS_POLICY.status.labels.DANGER, "异常件");

const fixtures = JSON.parse(
  await readFile(
    resolve(projectDir, "contracts/fixtures/status-packages.v1.json"),
    "utf8",
  ),
);

const {
  buildWidgetSnapshot,
  mergeTracks,
  packageSemantic,
  parseProviderTime,
} = await import("../services/status");

for (const fixture of fixtures.cases) {
  if (fixture.mergeTracks != null) {
    const makeTracks = (values: Array<{
      timeText: string;
      detail: string;
      statusCode: string;
    }>): TrackNode[] => values.map((track) => ({
      ...track,
      timeMs: parseProviderTime(track.timeText),
      raw: track.statusCode ? { statusCode: track.statusCode } : {},
    }));
    const tracks = mergeTracks(
      makeTracks(fixture.mergeTracks.cached),
      makeTracks(fixture.mergeTracks.refreshed),
    );
    assert.equal(tracks.length, fixture.expectedTrackCount, fixture.name);
    assert.equal(
      tracks[0]?.statusCode,
      fixture.expectedLatestStatusCode,
      fixture.name,
    );
    continue;
  }
  if (fixture.summaryState != null) {
    const tracks: TrackNode[] = fixture.tracks.map((track: {
      timeText: string;
      detail: string;
      statusCode: string;
    }) => ({
      ...track,
      timeMs: parseProviderTime(track.timeText),
      raw: {},
    }));
    const result = packageSemantic(fixture.summaryState, tracks);
    assert.equal(result.semantic, fixture.expectedSemantic, fixture.name);
    assert.equal(tracks[0]?.statusCode, fixture.expectedLatestStatusCode, fixture.name);
    continue;
  }

  const now = Date.UTC(2026, 7, 26, 6, 0, 0);
  const shipments: Shipment[] = fixture.semantics.map(
    (semantic: StatusSemantic, index: number) => ({
      identity: {
        id: `fixture:${index}`,
        bindingSource: null,
        sourceOwner: "manual",
        sourceId: `FIXTURE${index}`,
        phoneTail: "",
        courierCode: "TEST",
        companyName: "测试快递",
        manuallyAdded: true,
        createdAtMs: now,
      },
      timeline: {
        provider: "fixture",
        waybill: `FIXTURE${index}`,
        courierCode: "TEST",
        companyName: "测试快递",
        semantic,
        statusEventAtMs: now - index,
        latestTimeText: "2026-08-26 14:00:00",
        latestDetail: semantic,
        tracks: [],
        successAtMs: now,
      },
      updatedAtMs: now,
    }),
  );
  assert.equal(
    buildWidgetSnapshot(shipments, now).headline?.semantic,
    fixture.expectedHeadline,
    fixture.name,
  );
}

console.log("shared express contract tests passed");
