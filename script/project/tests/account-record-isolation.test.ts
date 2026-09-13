import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { saveGatewayToken } from "../services/credentials";
import { refreshAllShipments, runShipmentRefreshForTesting } from "../services/sync";
import type { AccountDetailRecord } from "../models";

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "pipi-test://shipment" },
});
Object.assign(Data, { fromFile: () => null });

const PHONE = "13800000000";
const PROVIDERS = ["CaiNiao", "JingDong"];
const timeText = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

for (const differentStatus of [false, true]) {
  test(`stable list/query packets retain independent records (different status: ${differentStatus})`, async () => {
    const realNow = Date.now, originalFetch = globalThis.fetch, originalSet = Storage.set;
    let clock = NOW, queryAt = NOW - 60000, listAt = NOW - 120000;
    let saves = 0, listCalls = 0;
    const records: AccountDetailRecord[] = [];
    Date.now = () => clock;
    const packet = (index: number, detail: boolean) => ({
      mailNo: `ZTISOLATION000${index}`, cpCode: "ZTO", name: "中通快递",
      provider: PROVIDERS[index], phone: PHONE,
      stateNum: detail || !differentStatus ? 104 : 103,
      details: [{ time: timeText(detail ? queryAt : listAt), desc: detail ? "Synthetic query event" : "Synthetic list event" }],
    });
    const response = (value: unknown) => {
      const text = JSON.stringify(value);
      return { ok: true, status: 200, expectedContentLength: text.length, text: async () => text };
    };
    try {
      memory.clear();
      saveState({ ...emptyState(), bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }] }, clock);
      saveGatewayToken("AbCdEfGh_123-456");
      Storage.set = ((key: string, value: unknown) => {
        if (key === "pipi_deliveries_state_v1") saves++;
        return originalSet(key, value);
      }) as typeof Storage.set;
      globalThis.fetch = (async (url: string, init?: { body?: string }) => {
        const path = new URL(url).pathname;
        if (path === "/api/express/accounts/sync") {
          listCalls++;
          return response({ code: 0, data: { expressList: PROVIDERS.map((_, index) => packet(index, false)) } });
        }
        if (path === "/api/express/timeline/source") {
          const body = JSON.parse(init?.body || "{}");
          assert.equal(body.mode, "detail", "Home supplementation remains source-only");
          records.push(body.record);
          return response({ code: 0, data: packet(Number(body.record.waybill.slice(-1)), true) });
        }
        throw new Error(`Unexpected synthetic route: ${path}`);
      }) as typeof fetch;
      const refresh = () => refreshAllShipments("interface5", {
        accountSourceFollowup: true, forceManualRefresh: true, accountOrderProjection: false,
      });
      const first = await refresh();
      assert.equal(first.failed, 0);
      assert.equal(first.succeeded, 2, "Home only queries the newly observed Cainiao parcel");
      const refreshJdDetail = () => runShipmentRefreshForTesting(
        loadState(clock).shipments.find(row => row.identity.sourceProvider === "JingDong")!.identity.id,
        { isCurrent: () => true }, { trigger: "detail_open" },
      );
      await refreshJdDetail();
      const byWaybill = (values: AccountDetailRecord[]) => values.slice().sort((a, b) => a.waybill.localeCompare(b.waybill));
      const originalRecords = byWaybill(records);
      const originalRevision = loadState(clock).revision;
      for (let repeat = 0; repeat < 2; repeat++) {
        clock += 60000;
        saves = 0;
        records.length = 0;
        const result = await refresh();
        assert.equal(result.failed, 0);
        assert.equal(result.succeeded, 1, "unchanged Home list starts no account query");
        assert.deepEqual(records, []);
        assert.equal(saves, 0, "unchanged list and query evidence must not alternate whole-state writes");
        assert.equal(loadState(clock).revision, originalRevision);
      }
      assert.equal(listCalls, 3);
      queryAt = NOW;
      clock += 60000;
      const changed = await refresh();
      assert.equal(changed.failed, 0);
      assert.deepEqual(records, [], "query-owned changes cannot trigger Home work");
      assert.equal(saves, 0);
      await refreshJdDetail();
      assert.deepEqual(byWaybill(records), originalRecords.filter(record => record.provider === "JingDong"),
        "detail uses the original list tuple and metadata");
      assert.ok(saves > 0, "new query evidence must still be saved");
      for (const row of loadState(clock).shipments) {
        assert.equal(row.timeline.latestTimeText, timeText(row.identity.sourceProvider === "JingDong"
          ? queryAt : NOW - 60000), "only explicit JD detail queried the newer result");
        assert.equal(row.sourceTimeline?.latestTimeText, timeText(listAt));
        assert.equal(row.accountRecord?.updateTime, timeText(listAt));
        assert.equal(row.accountRecord?.stateNumber, differentStatus ? 103 : 104);
      }
      listAt = NOW + 60000;
      clock += 60000;
      records.length = 0;
      assert.equal((await refresh()).failed, 0);
      assert.equal(records.length, 1);
      assert.equal(records[0].provider, "CaiNiao", "new JD list evidence is applied without a query");
      assert.ok(records.every(record => record.updateTime === timeText(listAt)),
        "a changed list packet updates subsequent request parameters");
      assert.ok(loadState(clock).shipments.every(row => row.timeline.latestTimeText === timeText(listAt)),
        "new list evidence can take presentation back from the older query");
    } finally {
      Date.now = realNow;
      globalThis.fetch = originalFetch;
      Storage.set = originalSet;
    }
  });
}
