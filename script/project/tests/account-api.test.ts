import assert from "node:assert/strict";
import {
  AccountApi,
  AccountApiError,
  ACCOUNT_REQUEST_TIMEOUT_MS,
  buildAccountBindRequest,
  buildAccountCodeRequest,
  buildAccountSyncRequest,
  buildAccountTimelineRequest,
  normalizePhones,
} from "../services/account-api";

const v5 = {
  userId: "1234567890",
  oaid: "0011223344556677",
  vaid: "8899aabbccddeeff",
} as const;

assert.deepEqual(buildAccountCodeRequest({
  source: "interface5",
  identity: v5,
  phone: "138-0013-8000",
}), {
  route: "/api/express/accounts/code",
  payload: { interface: "v5", identity: v5, phone: "13800138000" },
});
assert.throws(
  () => buildAccountBindRequest({
    source: "interface6",
    identity: v5,
    phone: "13800138000",
    code: "123456",
  } as never),
  /当前快递服务不可用/,
);
assert.throws(
  () => buildAccountBindRequest({
    source: "interface5", identity: v5, phone: "13800138000", code: "1234567",
  }),
  /验证码/,
);

assert.deepEqual(normalizePhones([
  "13800138000", "138 0013 8000", "13900139000",
]), ["13800138000", "13900139000"]);
assert.deepEqual(normalizePhones([
  "13800138000",
  "13900139000",
  "13700137000",
  "13600136000",
  "13500135000",
]), [
  "13800138000",
  "13900139000",
  "13700137000",
  "13600136000",
  "13500135000",
]);
assert.throws(
  () => normalizePhones([
    "13800138000",
    "13900139000",
    "13700137000",
    "13600136000",
    "13500135000",
    "13400134000",
  ]),
  /最多可绑定 5 个手机号/,
);
assert.deepEqual(buildAccountSyncRequest({
  source: "interface5",
  identity: v5,
  phones: ["13800138000"],
}).payload, {
  interface: "v5",
  identity: v5,
  phones: ["13800138000"],
});
assert.throws(
  () => buildAccountSyncRequest({
    source: "interface6",
    identity: v5,
  } as never),
  /当前快递服务不可用/,
);

assert.deepEqual(buildAccountTimelineRequest({
  source: "interface5",
  mode: "detail",
  identity: v5,
  record: {
    waybill: "79025657335745",
    companyCode: "ZTO",
    name: "中通快递",
    provider: "CaiNiao",
    stateNumber: 107,
    updateTime: "2026-08-16 17:03:18",
    phone: "13800138000",
  },
}).payload, {
  interface: "v5",
  mode: "detail",
  identity: v5,
  record: {
    waybill: "79025657335745",
    companyCode: "ZTO",
    name: "中通快递",
    provider: "CaiNiao",
    stateNumber: 107,
    updateTime: "2026-08-16 17:03:18",
    phone: "13800138000",
    channel: 1,
  },
});
assert.deepEqual(buildAccountTimelineRequest({
  source: "interface5",
  mode: "manual",
  identity: v5,
  waybill: "611704092029773",
  phones: [
    "13800138000",
    "13900139000",
    "13700137000",
    "13600136000",
    "13500135000",
  ],
}).payload, {
  interface: "v5",
  identity: v5,
  mode: "manual",
  waybill: "611704092029773",
  phones: [
    "13800138000",
    "13900139000",
    "13700137000",
    "13600136000",
    "13500135000",
  ],
});

async function main(): Promise<void> {
  const calls: Array<{
    route: string;
    payload: Record<string, unknown>;
    timeoutMs: number;
  }> = [];
  const api = new AccountApi(async (route, payload, timeoutMs) => {
    calls.push({ route, payload, timeoutMs });
    return { code: 0 };
  });
  await api.sendCode({ source: "interface5", identity: v5, phone: "13800138000" });
  await api.bind({
    source: "interface5", identity: v5, phone: "13800138000", code: "1234",
  });
  await api.sync({ source: "interface5", identity: v5, phones: ["13800138000"] });
  assert.deepEqual(calls.map((call) => call.route), [
    "/api/express/accounts/code",
    "/api/express/accounts/bind",
    "/api/express/accounts/sync",
  ]);
  assert.equal(calls.every((call) => call.timeoutMs === ACCOUNT_REQUEST_TIMEOUT_MS), true);

  const rejected = new AccountApi(
    async () => ({ code: 500, message: "private upstream text" }),
  );
  await assert.rejects(
    rejected.bind({
      source: "interface5", identity: v5, phone: "13800138000", code: "1234",
    }),
    (error: unknown) => error instanceof AccountApiError
      && error.code === "UPSTREAM_REJECTED"
      && !error.message.includes("private upstream text"),
  );
}

void main().then(() => {
  console.log("account api tests passed");
});
