import assert from "node:assert/strict";
import {
  detectKuaidi100CarrierCandidates,
  parseKuaidi100CarrierCandidates,
} from "../services/kuaidi100-carrier-detection";

assert.deepEqual(
  parseKuaidi100CarrierCandidates({
    auto: [
      { comCode: "shunfeng", name: "顺丰速运" },
      { code: "zhongtong", comName: "中通快递" },
      { comCode: "shunfeng", name: "重复候选" },
      { name: "无编码" },
    ],
  }),
  [
    { courierCode: "shunfeng", companyName: "顺丰速运" },
    { courierCode: "zhongtong", companyName: "中通快递" },
  ],
);
assert.deepEqual(parseKuaidi100CarrierCandidates({ result: false }), []);
assert.deepEqual(
  parseKuaidi100CarrierCandidates([
    { comCode: "jd", name: "京东快递" },
    { comCode: "invalid code", name: "无效候选" },
  ]),
  [{ courierCode: "jd", companyName: "京东快递" }],
);

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init: Record<string, unknown> }> = [];

try {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      init: init as unknown as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      auto: [{ comCode: "yuantong", name: "圆通速递" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  assert.deepEqual(
    await detectKuaidi100CarrierCandidates("YT1234567890"),
    [{ courierCode: "yuantong", companyName: "圆通速递" }],
  );
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.origin, "https://www.kuaidi100.com");
  assert.equal(requestUrl.pathname, "/autonumber/autoComNum");
  assert.equal(requestUrl.searchParams.get("text"), "YT1234567890");
  assert.equal(requestUrl.searchParams.has("key"), false);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
  });
  assert.equal(calls[0].init.timeout, 15);
  assert.equal(
    calls[0].init.debugLabel,
    "Pipi Deliveries Kuaidi100 carrier detection",
  );

  globalThis.fetch = async () => new Response("upstream unavailable", {
    status: 503,
  });
  await assert.rejects(
    detectKuaidi100CarrierCandidates("YT1234567890"),
    /暂时无法识别承运商/,
  );

  let stalledSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_url, init = {}) => {
    stalledSignal = (init as { signal?: AbortSignal }).signal;
    return {
      ok: true,
      status: 200,
      expectedContentLength: 32,
      text: () => new Promise<string>(() => {}),
    };
  }) as typeof globalThis.fetch;
  const parent = new AbortController();
  const stalled = detectKuaidi100CarrierCandidates("YT1234567890", {
    deadlineAtMs: Date.now() + 10_000,
    signal: parent.signal,
  });
  await Promise.resolve();
  parent.abort();
  await assert.rejects(stalled, /请求超时/);
  assert.equal(stalledSignal?.aborted, true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Kuaidi100 local carrier detection tests passed");
