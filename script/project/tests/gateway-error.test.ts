import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

type FakeData = { value: string };

const memory = new Map<string, string>();
const shared = new Map<string, unknown>();
const files = new Map<string, string>();
let fetchCalls = 0;
let responseStatus = 401;
type FakeFetchInit = { signal?: AbortSignal };

function gatewayResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    expectedContentLength: 24,
    text: async () => JSON.stringify({
      error: status === 401 ? "unauthorized" : "forbidden",
    }),
  };
}

let fetchHandler: (
  init?: FakeFetchInit,
) => Promise<ReturnType<typeof gatewayResponse>> = async () =>
  gatewayResponse(responseStatus);

Object.assign(globalThis, {
  Data: {
    fromIntArray: () => ({ value: "" }),
    fromRawString: (value: string) => ({ value }),
  },
  Crypto: {
    sha256: (data: FakeData) => ({
      toHexString: () => createHash("sha256").update(data.value).digest("hex"),
    }),
    hmacSHA256: (data: FakeData, key: FakeData) => ({
      toHexString: () => createHmac("sha256", key.value)
        .update(data.value)
        .digest("hex")
        .toUpperCase(),
    }),
    generateSymmetricKey: () => ({
      toHexString: () => "0123456789abcdef0123456789abcdef",
    }),
  },
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return files.has(path);
    },
    isFileSync(path: string) {
      return files.has(path);
    },
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing synthetic file");
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) {
        throw new Error("synthetic rename rejected");
      }
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string): string | null {
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): boolean {
      memory.set(key, value);
      return true;
    },
    remove(key: string): boolean {
      memory.delete(key);
      return true;
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (shared.get(key) as T | undefined) ?? null;
    },
    remove(key: string): void {
      shared.delete(key);
    },
  },
  fetch: (_url: string, init?: FakeFetchInit) => {
    fetchCalls += 1;
    return fetchHandler(init);
  },
});

const {
  GatewayError,
  gatewayErrorCode,
  hmacSha256Hex,
  postGateway,
  scriptingAuthHeaders,
} = await import("../services/gateway");
const { OperationTimeoutError } = await import("../services/deadline");
const {
  gatewayCredentialStatus,
  loadGatewayCredentials,
  saveGatewayToken,
} = await import("../services/credentials");

assert.equal(
  hmacSha256Hex("synthetic-key", "synthetic-message"),
  createHmac("sha256", "synthetic-key")
    .update("synthetic-message")
    .digest("hex"),
);

const token = "AbCdEfGh_123-456";
const timestamp = 1_777_777_777;
const nonce = "0123456789abcdef0123456789abcdef";
const route = "/api/express/classify";
const body = JSON.stringify({ waybill: "SYNTHETIC123" });
const bodySha256 = createHash("sha256").update(body).digest("hex");
const canonical = [
  "scripting-v1",
  String(timestamp),
  nonce,
  "POST",
  route,
  bodySha256,
].join("\n");
assert.deepEqual(
  scriptingAuthHeaders(token, timestamp, nonce, route, bodySha256),
  {
    "X-Scripting-Version": "1",
    "X-Scripting-Token": token,
    "X-Scripting-Timestamp": String(timestamp),
    "X-Scripting-Nonce": nonce,
    "X-Scripting-Signature": createHmac("sha256", token)
      .update(canonical)
      .digest("hex"),
  },
);

assert.equal(gatewayErrorCode('{"error":"unauthorized"}'), "unauthorized");
assert.equal(gatewayErrorCode('{"error":"expired_request"}'), "expired_request");
assert.equal(gatewayErrorCode('{"error":"phone=13800138000"}'), "");
assert.equal(gatewayErrorCode('{"error":"phone_13800138000"}'), "");
assert.equal(gatewayErrorCode('{"error":"AbCdEfGhIjKlMnOp"}'), "");
assert.equal(gatewayErrorCode('{"message":"private upstream text"}'), "");
assert.equal(gatewayErrorCode("not json"), "");
assert.equal(gatewayErrorCode("x".repeat(4_097)), "");

function rejectedWithStatus(status: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, status);
    return true;
  };
}

// A generic authorization failure belongs to that request only. The gateway has no
// durable revocation contract, so the next request must still reach the network.
saveGatewayToken(token);
responseStatus = 401;
await assert.rejects(
  postGateway("/api/express/classify", { waybill: "SYNTHETIC123" }),
  rejectedWithStatus(401),
);
assert.equal(gatewayCredentialStatus(), "configured");
assert.deepEqual(loadGatewayCredentials(), { token });
const callsAfterRejection = fetchCalls;
responseStatus = 200;
await postGateway("/api/express/classify", { waybill: "SYNTHETIC123" });
assert.equal(fetchCalls, callsAfterRejection + 1);

responseStatus = 403;
await assert.rejects(
  postGateway("/api/express/timeline/preferred", {
    waybill: "SF-SYNTHETIC456",
    companyCode: "shunfeng",
  }),
  rejectedWithStatus(403),
);
assert.equal(gatewayCredentialStatus(), "configured");
const callsAfterShunFengRejection = fetchCalls;
responseStatus = 200;
await postGateway("/api/express/timeline/preferred", {
  waybill: "STO-SYNTHETIC456",
  companyCode: "shentong",
});
assert.equal(fetchCalls, callsAfterShunFengRejection + 1);

const replacementToken = "ZyXwVuTs_987-654";
saveGatewayToken(replacementToken);
assert.deepEqual(loadGatewayCredentials(), { token: replacementToken });

// A delayed rejection must not affect a newer credential saved while the request
// was in flight.
let resolveDelayedResponse:
  | ((response: ReturnType<typeof gatewayResponse>) => void)
  | undefined;
fetchHandler = () => new Promise((resolve) => {
  resolveDelayedResponse = resolve;
});
const delayedRequest = postGateway(
  "/api/express/classify",
  { waybill: "SYNTHETIC789" },
);
const newestToken = "MnOpQrSt_246-810";
saveGatewayToken(newestToken);
assert.ok(resolveDelayedResponse);
resolveDelayedResponse(gatewayResponse(401));
await assert.rejects(delayedRequest, rejectedWithStatus(401));
assert.equal(gatewayCredentialStatus(), "configured");
assert.deepEqual(loadGatewayCredentials(), { token: newestToken });

async function rejectsAsOperationTimeout(promise: Promise<unknown>) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        promise,
        new Promise((_, reject) => {
          guard = setTimeout(
            () => reject(new Error("gateway deadline did not settle")),
            500,
          );
        }),
      ]),
      (error: unknown) => error instanceof OperationTimeoutError,
    );
  } finally {
    if (guard != null) clearTimeout(guard);
  }
}

let stalledFetchSignal: AbortSignal | undefined;
fetchHandler = (init) => new Promise((_resolve, reject) => {
  stalledFetchSignal = init?.signal;
  init?.signal?.addEventListener("abort", () => {
    const aborted = new Error("synthetic abort");
    aborted.name = "AbortError";
    reject(aborted);
  }, { once: true });
});
await rejectsAsOperationTimeout(postGateway(
  "/api/express/classify",
  { waybill: "SYNTHETIC-TIMEOUT-FETCH" },
  { deadlineAtMs: Date.now() + 20 },
));
assert.equal(stalledFetchSignal?.aborted, true);

let stalledBodySignal: AbortSignal | undefined;
let resolveLateBody: ((value: string) => void) | undefined;
fetchHandler = async (init) => {
  stalledBodySignal = init?.signal;
  return {
    ...gatewayResponse(200),
    text: () => new Promise<string>((resolve) => {
      resolveLateBody = resolve;
    }),
  };
};
await rejectsAsOperationTimeout(postGateway(
  "/api/express/classify",
  { waybill: "SYNTHETIC-TIMEOUT-BODY" },
  { deadlineAtMs: Date.now() + 20 },
));
assert.equal(stalledBodySignal?.aborted, true);
assert.ok(resolveLateBody);
resolveLateBody(JSON.stringify({ ok: true }));
await Promise.resolve();

const parentController = new AbortController();
let parentControlledSignal: AbortSignal | undefined;
fetchHandler = async (init) => {
  parentControlledSignal = init?.signal;
  return {
    ...gatewayResponse(200),
    text: () => new Promise<string>(() => {}),
  };
};
const parentControlledRequest = postGateway(
  "/api/express/classify",
  { waybill: "SYNTHETIC-PARENT-ABORT" },
  { deadlineAtMs: Date.now() + 10_000, signal: parentController.signal },
);
await Promise.resolve();
parentController.abort();
await rejectsAsOperationTimeout(parentControlledRequest);
assert.equal(parentControlledSignal?.aborted, true);

const preAborted = new AbortController();
preAborted.abort();
const callsBeforePreAbort = fetchCalls;
await rejectsAsOperationTimeout(postGateway(
  "/api/express/classify",
  { waybill: "SYNTHETIC-PRE-ABORT" },
  { deadlineAtMs: Date.now() + 10_000, signal: preAborted.signal },
));
assert.equal(fetchCalls, callsBeforePreAbort);

console.log("gateway error diagnostics tests passed");
