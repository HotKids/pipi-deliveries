import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  carrierRecognitionExhausted,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
} from "../services/carrier-recognition";
import { carrierAwaitingRecognition } from "../services/carrier-gate";
import { applyAccountShipment } from "../services/shipment-policy";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";

// 用户 2026-09-27 提交前核对答复五：识别记录里带「已放弃」（exhaustedAtMs）的记录不参与挤掉——256 条临时记录上限淘汰时
// 跳过它们。否则一张已经放行过的运单（其余裁决 32：识别进入终态、终态 24 小时到期后重试又失败）的记录被别的运单挤掉，
// 放弃标记跟着丢了，它下一次重试失败就被当成新运单记成第 1 次失败，通知又被压住。

const PHONE = "13800002929";
const DAY = 86400000;
const MINUTE = 60000;
const CACHE_KEY = "pipi_deliveries_carrier_recognition_v1";
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => {} },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
});

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function entries(): CarrierRecognitionEntry[] {
  const raw = Storage.get<string>(CACHE_KEY, { shared: true });
  return typeof raw === "string" ? JSON.parse(raw) : [];
}

const offline = async () => { throw new Error("Synthetic offline"); };

{
  clock = NOW;
  memory.clear();
  const released = "JT4006839600091";
  // The released waybill: recognition gave up on it before (exhaustedAtMs), its terminal verdict expired, and a retry
  // failed again — a transient retry record that still carries the mark. It is the oldest transient record.
  const exhausted: CarrierRecognitionEntry = {
    waybill: released, state: "retry", candidates: [], retryStage: "auto_com_num", networkFailures: 1,
    retryAfterMs: NOW - MINUTE, updatedAtMs: NOW - 2 * DAY, exhaustedAtMs: NOW - 3 * DAY,
  };
  // 256 newer transient records of other waybills: the cap is full.
  const others: CarrierRecognitionEntry[] = Array.from({ length: 256 }, (_, index) => ({
    waybill: `YT${String(7000000000000 + index)}`, state: "retry", candidates: [], retryStage: "auto_com_num",
    networkFailures: 1, retryAfterMs: NOW + 15 * MINUTE, updatedAtMs: NOW - DAY + index,
  }));
  Storage.set(CACHE_KEY, JSON.stringify([exhausted, ...others]), { shared: true });
  assert.equal(carrierRecognitionExhausted(released), true, "precondition: released after an exhausted recognition");

  // Another waybill's failure is written: the transient records are over the cap.
  await recognizeNonSyncCarrier("YT7000000009999", { detect: offline });

  // The released waybill is asked again and fails again.
  await recognizeNonSyncCarrier(released, { detect: offline });

  // Its row, still without a matched carrier, changes status: the change must go out, not wait for a carrier again.
  const record = (stateNum: number, at: number, desc: string) => ({
    mailNo: released, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc }],
  });
  const row = (stateNum: number, at: number, desc: string): Shipment => {
    const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record(stateNum, at, desc)] } })[0]!;
    const shipment = applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], at)!, at);
    return { ...shipment, identity: { ...shipment.identity, courierCode: "", companyName: "" } };
  };
  const transit = row(104, NOW - DAY, "快件已到达【杭州转运中心】");
  const delivering = row(105, NOW - 3600000, "【上海市】快件正在派送中");
  saveState({ ...emptyState(), shipments: [transit],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 2 * DAY }], feedSlotRebuiltAtMs: NOW - DAY }, NOW);
  const base = loadState();
  const state = commitRefreshState(base, { ...base, shipments: [delivering] }, "interface5", clock, undefined, {
    previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: "retention-round",
  }).state;
  assert.equal(state.pendingNotifications?.length, 1);
  assert.notEqual(state.pendingNotifications?.[0]?.awaitingCarrier, true, "its notification is not held again");
  assert.equal(carrierAwaitingRecognition(delivering), false,
    "a released waybill whose retry failed again is not held for its carrier again");

  // The mark survived the cap, and the retry carried it forward.
  const kept = entries().find((entry) => entry.waybill === released);
  assert.equal(kept?.exhaustedAtMs, NOW - 3 * DAY);
  assert.equal(kept?.networkFailures, 2, "the retry failure is counted on the same record");
  // The cap still holds for the others: the oldest ordinary transient record gave way.
  const ordinary = entries().filter((entry) =>
    entry.state !== "resolved" && entry.state !== "terminal" && !(Number(entry.exhaustedAtMs) > 0));
  assert.equal(ordinary.length, 256);
  assert.equal(ordinary.some((entry) => entry.waybill === others[0].waybill), false);
}

console.log("carrier exhausted retention tests passed");
