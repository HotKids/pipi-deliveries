import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { enhancementIdentityFingerprint, loadEnhancementIdentity } from "../services/enhanced-account";
import { addBinding, commitRefreshState, emptyState, enableBindingEnhancement,
  loadState, privateHash, saveState } from "../services/storage";
import { refreshAllShipments, unbindPhone } from "../services/sync";
import { acquireRenewingDurableRefreshLease } from "../services/refresh-runtime-state";

const PHONE = "13800000000";
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  Widget: { reloadAll() {} }, Script: { directory: "/synthetic", name: "Synthetic" },
});
let requests = 0, status = 503;
globalThis.fetch = (async (_url: string, options: { body: string }) => {
  const body = JSON.parse(options.body);
  assert.equal(body.operation, "unbind");
  assert.equal(body.phone, PHONE);
  assert.equal(body.identity.accountId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  requests++;
  return { ok: status === 200, status,
    text: async () => JSON.stringify(status === 200 ? { ok: true } : { error: "upstream_unavailable" }) };
}) as typeof fetch;
function seed(withIdentity = true) {
  memory.clear(); requests = 0; status = 503;
  saveState({ ...emptyState(), bindings: [{ source: "interface5", phone: PHONE,
    boundAtMs: NOW - 1_000, enhancedMode: true, enhancedAtMs: NOW - 500 }] });
  saveGatewayToken("AbCdEfGh_123-456");
  if (withIdentity) enableBindingEnhancement(PHONE, NOW - 1_000, NOW - 500,
    enhancementIdentityFingerprint(loadEnhancementIdentity()));
  return loadState().bindings[0];
}

const binding = seed();
await assert.rejects(unbindPhone("interface5", PHONE));
assert.deepEqual(loadState().bindings, [binding], "ordinary remote failure still preserves both local modes");
const removed = await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: binding });
assert.equal(removed.bindings.length, 0, "explicit local removal cannot be blocked by unavailable upstream");
assert.equal(requests, 1, "explicit local removal never repeats the failed remote call");
assert.equal(removed.pendingEnhancementUnsubscribes?.length, 1,
  "local removal and its pending remote obligation commit together");
assert.match(removed.pendingEnhancementUnsubscribes![0].identityFingerprint, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(removed.pendingEnhancementUnsubscribes).includes("accountId"), false,
  "the business outbox retains only an identity fingerprint, not another privileged identity copy");

const { replayEnhancementUnsubscribes } = await import("../services/enhancement-unsubscribe");
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1, "failed replay remains durable");
status = 200;
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0, "successful replay acknowledges its own obligation");
const afterSuccess = requests;
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, afterSuccess, "acknowledged unsubscription is not resent");

const missing = seed(false);
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: missing });
assert.equal(loadState().bindings.length, 0, "missing identity cannot trap a phone on this device");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1,
  "missing identity must not be treated as proof of remote absence");
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 0, "an unknown original identity cannot be replaced for remote cleanup");

const staleBinding = seed();
saveState({ ...loadState(), bindings: [{ ...staleBinding, boundAtMs: staleBinding.boundAtMs + 1 }] });
await assert.rejects(unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: staleBinding }), /绑定已变更/);
assert.equal(loadState().bindings.length, 1);
assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0);

const beforePending = emptyState();
const retainedBinding = seed();
const staleRefresh = loadState();
const pendingState = await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: retainedBinding });
const [pending] = pendingState.pendingEnhancementUnsubscribes!;
assert.deepEqual(saveState(beforePending).pendingEnhancementUnsubscribes, [pending],
  "an ordinary snapshot captured before local removal cannot erase its new durable obligation");
assert.deepEqual(commitRefreshState(staleRefresh, staleRefresh, "interface5").state.pendingEnhancementUnsubscribes, [pending],
  "a refresh captured before local removal preserves the current outbox and cannot restore the removed binding");
assert.equal(loadState().bindings.length, 0);
const staleWithPending = loadState();
status = 200;
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(saveState(staleWithPending).pendingEnhancementUnsubscribes?.length || 0, 0,
  "a stale ordinary snapshot cannot resurrect an acknowledged obligation");
assert.equal(commitRefreshState(staleWithPending, staleWithPending, "interface5").state.pendingEnhancementUnsubscribes?.length || 0, 0,
  "a late refresh cannot resurrect an acknowledged obligation");

const oldBinding = seed();
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: oldBinding });
const reenabledAt = Date.now();
addBinding("interface5", PHONE, reenabledAt);
enableBindingEnhancement(PHONE, reenabledAt, reenabledAt + 1, enhancementIdentityFingerprint(loadEnhancementIdentity()));
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 0, "re-enhancement under the original identity cancels old cleanup without unsubscribing the active phone");
assert.equal(loadState().bindings[0].enhancedMode, true);
assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0);

function removeIdentityCopies() {
  for (const key of memory.keys()) if (key.includes("account-enhancement-identity-v1.json") ||
    key === "pipi_deliveries_account_enhancement_identity_shared_v1" ||
    key === "keychain:pipi_deliveries_account_enhancement_identity_v1") memory.delete(key);
}
const changedIdentityBinding = seed();
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: changedIdentityBinding });
const originalUUID = UUID.string;
removeIdentityCopies();
UUID.string = () => "11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
try { loadEnhancementIdentity(); }
finally { UUID.string = originalUUID; }
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 0, "a later identity cannot unsubscribe an obligation belonging to the original identity");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);
const newBoundAt = Date.now();
addBinding("interface5", PHONE, newBoundAt);
enableBindingEnhancement(PHONE, newBoundAt, newBoundAt + 1, enhancementIdentityFingerprint(loadEnhancementIdentity()));
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 0);
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1,
  "an active phone under another identity cannot acknowledge the old subscription's obligation");

const unknownIdentityBinding = seed(false);
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: unknownIdentityBinding });
loadEnhancementIdentity();
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 0, "a newly established identity cannot resolve an obligation whose original identity is unknown");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);

const leasedBinding = seed();
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: leasedBinding });
const bindingLease = acquireRenewingDurableRefreshLease(`binding:${privateHash(PHONE)}`, 2_000);
assert.ok(bindingLease);
try {
  await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
  assert.equal(requests, 0, "replay cannot race a phone binding or unbinding that owns the same lease");
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);
} finally { bindingLease.release(); }
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() - 1 });
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000, isCurrent: () => false });
assert.equal(requests, 0, "expired and cancelled replay passes cannot contact the remote subscription");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);
status = 200;
await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000 });
assert.equal(requests, 1, "releasing the binding lease permits one subsequent eligible replay");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0);

for (const failurePhase of ["write", "publish"] as const) {
  const intactBinding = seed();
  const write = FileManager.writeAsStringSync, link = FileManager.createLinkSync;
  if (failurePhase === "write") FileManager.writeAsStringSync = (path, value) => {
    if (path.endsWith("/state.json")) throw new Error("synthetic state write failure");
    write(path, value);
  };
  else FileManager.createLinkSync = (path, target) => {
    if (path.endsWith("/next") && memory.has(`file:${target}/state.json`)) {
      throw new Error("synthetic state publication failure");
    }
    link(path, target);
  };
  try {
    await assert.rejects(unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: intactBinding }),
      undefined, `a required ${failurePhase} failure must fail local unbinding`);
  } finally {
    FileManager.writeAsStringSync = write;
    FileManager.createLinkSync = link;
  }
  assert.deepEqual(loadState().bindings, [intactBinding], "failed local removal keeps its exact original binding");
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0,
    "failed local removal cannot commit an obligation without removing its binding");
  assert.equal(requests, 0, "required persistence failure must not contact the remote subscription");
}

const cancelledBinding = seed();
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: cancelledBinding });
let currentReplay = true;
const setKeychain = Keychain.set;
Keychain.set = (key, value) => {
  if (key === "pipi_deliveries_account_enhancement_identity_v1") currentReplay = false;
  return setKeychain(key, value);
};
try {
  await replayEnhancementUnsubscribes({ deadlineAtMs: Date.now() + 1_000, isCurrent: () => currentReplay });
} finally { Keychain.set = setKeychain; }
assert.equal(currentReplay, false, "the synthetic identity read revokes replay ownership before its network request");
assert.equal(requests, 0, "replay must recheck ownership after loading the identity and before contacting the remote subscription");
assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);

const lastBinding = seed();
await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: lastBinding });
const failedReplay = await refreshAllShipments("interface5", {
  accountListOnly: true, backgroundHostSafe: true, budgetMs: 10_000,
});
assert.equal(failedReplay.failed, 0, "optional remote cleanup failure cannot fail the base refresh");
assert.equal(failedReplay.state.pendingEnhancementUnsubscribes?.length, 1);
status = 200;
const recoveredReplay = await refreshAllShipments("interface5", {
  accountListOnly: true, backgroundHostSafe: true, budgetMs: 10_000,
});
assert.equal(recoveredReplay.state.bindings.length, 0);
assert.equal(recoveredReplay.state.pendingEnhancementUnsubscribes?.length || 0, 0,
  "normal refresh replays and reports the remote ACK even after the last local binding was removed");
console.log("Enhanced local unbinding, durable replay, missing identity and generation fences passed");
