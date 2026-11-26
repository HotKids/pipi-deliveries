import type { AccountDetailRecord, BindingSource, ShipmentRoute } from "../models";
import { accountAppTargets, type AccountAppRoute, type AccountAppTarget } from "./account-app-links";
import { utf8Data } from "./scripting-data";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";

const ROUTES_KEY = "pipi_deliveries_routes_v1";
const ACCOUNT_APP_ROUTES_KEY = "pipi_deliveries_account_app_routes_v1";
const ORDER_PROJECTION_REFS_KEY =
  "pipi_deliveries_order_projection_refs_v1";
// 用户定 2026-09-05：拉到的路由/轨迹按来源缓存，**只在那一行从列表消失时才清**，不按时间过期。
// 原来 8 天到期就删，会把 picker 给的 K100 详情页地址、菜鸟路由平白丢掉，下一次只能重新拉。
// 保留各处的判式不改结构，把年龄阈值设成无穷大即等价于「不按时间清」。
const ROUTE_MAX_AGE_MS = Number.POSITIVE_INFINITY;
const MAX_ROUTE_LENGTH = 16_384;

type AccountAppRouteValue = AccountAppRoute & { updatedAtMs: number };
export type AccountAppRouteInput = Readonly<{ record: AccountDetailRecord; route: AccountAppRoute }>;

const appRouteKeyMemo = new Map<string, string>();
const APP_ROUTE_KEY_MEMO_LIMIT = 256;
let appRoutesParsedMemo: { raw: string; values: Record<string, AccountAppRouteValue> } | undefined;
let appRoutesInTurn: { get: unknown; values: Record<string, AccountAppRouteValue> } | undefined;
let appRoutesResetScheduled = false;

function forgetAppRoutesInTurn(): void {
  appRoutesInTurn = undefined;
}

function accountAppRouteKey(record: AccountDetailRecord): string {
  const provider = String(record.provider || "").toLowerCase();
  if (!record.waybill || !record.companyCode || !/^1[3-9]\d{9}$/.test(record.phone || "") ||
    !["jingdong", "cainiao", "shunfeng"].includes(provider)) return "";
  const lookupKey = `${SCRIPT_BINDING_SOURCE}\0${provider}\0${record.waybill}\0${record.companyCode}\0${record.phone}`;
  const remembered = appRouteKeyMemo.get(lookupKey);
  if (remembered !== undefined) {
    appRouteKeyMemo.delete(lookupKey);
    appRouteKeyMemo.set(lookupKey, remembered);
    return remembered;
  }
  const hashed = Crypto.sha256(utf8Data(JSON.stringify([
    SCRIPT_BINDING_SOURCE, provider, record.waybill, record.companyCode, record.phone,
  ]))).toHexString().toLowerCase();
  appRouteKeyMemo.set(lookupKey, hashed);
  if (appRouteKeyMemo.size > APP_ROUTE_KEY_MEMO_LIMIT) {
    appRouteKeyMemo.delete(appRouteKeyMemo.keys().next().value!);
  }
  return hashed;
}

function readAccountAppRoutes(strict = false): Record<string, AccountAppRouteValue> {
  let raw: string | null;
  try { raw = Keychain.get(ACCOUNT_APP_ROUTES_KEY); }
  catch (error) { if (strict) throw error; return {}; }
  if (!raw) return {};
  if (appRoutesParsedMemo?.raw === raw) return { ...appRoutesParsedMemo.values };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      appRoutesParsedMemo = { raw, values: value as Record<string, AccountAppRouteValue> };
      return { ...(value as Record<string, AccountAppRouteValue>) };
    }
    return {};
  } catch {
    return {};
  }
}

function readAccountAppRoutesInTurn(): Record<string, AccountAppRouteValue> {
  if (appRoutesInTurn && appRoutesInTurn.get === Keychain.get) {
    return appRoutesInTurn.values;
  }
  const values = readAccountAppRoutes();
  appRoutesInTurn = { get: Keychain.get, values };
  if (!appRoutesResetScheduled) {
    appRoutesResetScheduled = true;
    void Promise.resolve().then(() => {
      appRoutesResetScheduled = false;
      appRoutesInTurn = undefined;
    });
  }
  return values;
}

function writeAccountAppRoutes(value: Record<string, AccountAppRouteValue>): void {
  forgetAppRoutesInTurn();
  const serialized = JSON.stringify(value);
  if (!Keychain.set(ACCOUNT_APP_ROUTES_KEY, serialized)) {
    appRoutesParsedMemo = undefined;
    throw new Error("App links could not be saved");
  }
  appRoutesParsedMemo = { raw: serialized, values: { ...value } };
}

function validatedAccountAppTargets(record: AccountDetailRecord, route: AccountAppRoute): AccountAppTarget[] {
  if (!route || !Array.isArray(route.targets) || typeof route.secretKey !== "string") return [];
  return accountAppTargets(route.targets.map((target) => ({ type: "app", link: target?.url })),
    String(record.provider || "").toLowerCase(), record.waybill, record.companyCode || "", route.secretKey);
}

export function saveAccountAppRoutes(inputs: readonly AccountAppRouteInput[], now = Date.now()): number {
  const routes = readAccountAppRoutes();
  let saved = 0;
  for (const { record, route } of inputs) {
    const key = accountAppRouteKey(record);
    const targets = validatedAccountAppTargets(record, route);
    if (!key || !targets.length) continue;
    routes[key] = { targets, secretKey: route.secretKey, updatedAtMs: now };
    saved++;
  }
  if (saved) writeAccountAppRoutes(routes);
  return saved;
}

export function loadAccountAppRoutes(record: AccountDetailRecord, now = Date.now()): AccountAppTarget[] {
  const route = readAccountAppRoutesInTurn()[accountAppRouteKey(record)];
  return route && Number.isFinite(route.updatedAtMs) && route.updatedAtMs > 0 && route.updatedAtMs <= now
    ? validatedAccountAppTargets(record, route) : [];
}

export function pruneAccountAppRoutes(records: readonly AccountDetailRecord[]): void {
  forgetAppRoutesInTurn();
  const routes = readAccountAppRoutes(true);
  if (!Object.keys(routes).length) return;
  const retained = new Set(records.map(accountAppRouteKey).filter(Boolean));
  let changed = false;
  for (const key of Object.keys(routes)) {
    if (!retained.has(key)) {
      delete routes[key];
      changed = true;
    }
  }
  if (changed) writeAccountAppRoutes(routes);
}

type RouteValue = {
  url: string;
  source: BindingSource;
  kind?: ShipmentRoute["kind"];
  updatedAtMs: number;
};

type RouteMap = Record<string, RouteValue>;

type RouteMapRead = Readonly<{
  values: RouteMap;
  dirty: boolean;
}>;

export type OrderProjectionReferenceInput = Readonly<{
  ownerId: string;
  source: BindingSource;
  url: string;
}>;

export type ShipmentRouteMutation =
  | {
      key: string;
      kind: "save";
      targetId: string;
      source: BindingSource;
      routeKind?: ShipmentRoute["kind"];
      url: string;
    }
  | {
      key: string;
      kind: "move";
      fromId: string;
      targetId: string;
      source: BindingSource;
      routeKind?: ShipmentRoute["kind"];
    };

export type ShipmentRoutePublication = {
  key: string;
  targetId: string;
  source: BindingSource;
  routeKind: ShipmentRoute["kind"];
};

export type LegacyShipmentRouteMigration = {
  fromId: string;
  toId: string;
};

function trustedRoute(
  value: string,
  kind: ShipmentRoute["kind"] = "cainiao",
): string {
  const clean = String(value || "").trim();
  if (!/^https:\/\//i.test(clean) || clean.length > MAX_ROUTE_LENGTH) return "";
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    const trusted = kind === "web"
      ? host === "kuaidi100.com" || host.endsWith(".kuaidi100.com")
      : host === "cainiao.com" || host.endsWith(".cainiao.com") ||
        host === "taobao.com" || host.endsWith(".taobao.com");
    if (trusted) {
      return clean;
    }
  } catch {
    /* malformed routes are never persisted */
  }
  return "";
}

function trustedOrderProjectionRoute(value: string): string {
  const clean = String(value || "").trim();
  if (!/^https:\/\//i.test(clean) || clean.length > MAX_ROUTE_LENGTH) return "";
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    if (host === "jd.com" || host.endsWith(".jd.com")) return clean;
  } catch {
    /* malformed projection references are never persisted */
  }
  return "";
}

let orderProjectionRefsMemo: { raw: string; read: RouteMapRead } | undefined;

function readOrderProjectionRefs(strict = false): RouteMapRead {
  let raw: string | null;
  try { raw = Keychain.get(ORDER_PROJECTION_REFS_KEY); }
  catch (error) {
    if (strict) throw error;
    return { values: {}, dirty: true };
  }
  try {
    if (!raw) return { values: {}, dirty: false };
    if (orderProjectionRefsMemo?.raw === raw) {
      return { values: { ...orderProjectionRefsMemo.read.values }, dirty: orderProjectionRefsMemo.read.dirty };
    }
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { values: {}, dirty: true };
    }
    const values: RouteMap = {};
    let dirty = false;
    for (const [ownerId, rawEntry] of Object.entries(value)) {
      const entry = rawEntry && typeof rawEntry === "object" &&
          !Array.isArray(rawEntry)
        ? rawEntry as Partial<RouteValue>
        : null;
      const url = trustedOrderProjectionRoute(String(entry?.url || ""));
      const source = entry?.source;
      const updatedAtMs = Number(entry?.updatedAtMs);
      if (
        !ownerId.trim() ||
        !url ||
        source !== SCRIPT_BINDING_SOURCE ||
        !Number.isFinite(updatedAtMs) ||
        updatedAtMs <= 0
      ) {
        dirty = true;
        continue;
      }
      values[ownerId] = { url, source, updatedAtMs };
      if (
        entry?.url !== url ||
        entry?.updatedAtMs !== updatedAtMs
      ) dirty = true;
    }
    const parsedRead: RouteMapRead = { values, dirty };
    orderProjectionRefsMemo = { raw, read: { values: { ...values }, dirty } };
    return parsedRead;
  } catch {
    return { values: {}, dirty: true };
  }
}

function writeOrderProjectionRefs(value: RouteMap): void {
  try {
    const serialized = JSON.stringify(value);
    if (!Keychain.set(ORDER_PROJECTION_REFS_KEY, serialized)) {
      orderProjectionRefsMemo = undefined;
      throw new Error("订单详情保存失败，请稍后重试");
    }
    orderProjectionRefsMemo = { raw: serialized, read: { values: { ...value }, dirty: false } };
  } catch (error) {
    orderProjectionRefsMemo = undefined;
    if (error instanceof Error) throw error;
    throw new Error("订单详情保存失败，请稍后重试");
  }
}

export function saveOrderProjectionReferences(
  inputs: readonly OrderProjectionReferenceInput[],
  now = Date.now(),
): number {
  if (!inputs.length) return 0;
  const read = readOrderProjectionRefs();
  const refs = read.values;
  let saved = 0;
  for (const input of inputs) {
    requireScriptSource(input.source);
    const ownerId = String(input.ownerId || "").trim();
    const url = trustedOrderProjectionRoute(input.url);
    if (!ownerId || !url) continue;
    refs[ownerId] = { url, source: input.source, updatedAtMs: now };
    saved++;
  }
  if (saved || read.dirty) writeOrderProjectionRefs(refs);
  return saved;
}

export function loadOrderProjectionReference(
  ownerId: string,
  expectedSource: BindingSource,
  now = Date.now(),
): string {
  requireScriptSource(expectedSource);
  const value = readOrderProjectionRefs().values[String(ownerId || "").trim()];
  if (
    !value ||
    value.source !== expectedSource ||
    value.updatedAtMs <= 0 ||
    value.updatedAtMs > now ||
    now - value.updatedAtMs >= ROUTE_MAX_AGE_MS
  ) {
    return "";
  }
  return trustedOrderProjectionRoute(value.url);
}

export function removeOrderProjectionReferences(
  ownerIds: readonly string[],
): void {
  if (!ownerIds.length) return;
  const read = readOrderProjectionRefs();
  const refs = read.values;
  let changed = read.dirty;
  for (const ownerId of ownerIds) {
    if (!(ownerId in refs)) continue;
    delete refs[ownerId];
    changed = true;
  }
  if (changed) writeOrderProjectionRefs(refs);
}

export function pruneOrderProjectionReferences(
  retained: readonly Readonly<{ ownerId: string; source: BindingSource }>[],
  now = Date.now(),
): void {
  const retainedSources = new Map(
    retained.map((item) => [item.ownerId, item.source]),
  );
  const read = readOrderProjectionRefs(true);
  const refs = read.values;
  let changed = read.dirty;
  for (const [ownerId, value] of Object.entries(refs)) {
    if (
      retainedSources.get(ownerId) !== value?.source ||
      value.source !== SCRIPT_BINDING_SOURCE ||
      value.updatedAtMs <= 0 ||
      value.updatedAtMs > now ||
      now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
      !trustedOrderProjectionRoute(value.url)
    ) {
      delete refs[ownerId];
      changed = true;
    }
  }
  if (changed) writeOrderProjectionRefs(refs);
}

let routesParsedMemo: { raw: string; values: RouteMap } | undefined;

function read(strict = false): RouteMap {
  let raw: string | null;
  try { raw = Keychain.get(ROUTES_KEY); }
  catch (error) { if (strict) throw error; return {}; }
  if (!raw) return {};
  if (routesParsedMemo?.raw === raw) return { ...routesParsedMemo.values };
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      routesParsedMemo = { raw, values: value as RouteMap };
      return { ...(value as RouteMap) };
    }
    return {};
  } catch {
    return {};
  }
}

function write(value: RouteMap): void {
  try {
    const serialized = JSON.stringify(value);
    if (!Keychain.set(ROUTES_KEY, serialized)) {
      routesParsedMemo = undefined;
      throw new Error("快递详情保存失败，请稍后重试");
    }
    routesParsedMemo = { raw: serialized, values: { ...value } };
  } catch (error) {
    routesParsedMemo = undefined;
    if (error instanceof Error) throw error;
    throw new Error("快递详情保存失败，请稍后重试");
  }
}

export function saveShipmentRoute(
  shipmentId: string,
  source: BindingSource,
  url: string,
  now = Date.now(),
  kind: ShipmentRoute["kind"] = "cainiao",
): boolean {
  requireScriptSource(source);
  const trusted = trustedRoute(url, kind);
  if (!shipmentId || !trusted) return false;
  const routes = read();
  routes[shipmentId] = { url: trusted, source, kind, updatedAtMs: now };
  write(routes);
  return true;
}

export function loadShipmentRoute(
  shipmentId: string,
  expectedSource: BindingSource,
  now = Date.now(),
  expectedKind: ShipmentRoute["kind"] = "cainiao",
): string {
  requireScriptSource(expectedSource);
  const value = read()[shipmentId];
  if (
    !value ||
    value.source !== expectedSource ||
    (value.kind || "cainiao") !== expectedKind ||
    value.updatedAtMs <= 0 ||
    value.updatedAtMs > now ||
    now - value.updatedAtMs >= ROUTE_MAX_AGE_MS
  ) {
    return "";
  }
  return trustedRoute(value.url, expectedKind);
}

export function removeShipmentRoutes(ids: readonly string[]): void {
  if (!ids.length) return;
  const routes = read();
  let changed = false;
  for (const id of ids) {
    if (!(id in routes)) continue;
    delete routes[id];
    changed = true;
  }
  if (changed) write(routes);
}

export function moveShipmentRoute(
  fromId: string,
  toId: string,
  expectedSource: BindingSource,
  now = Date.now(),
  expectedKind: ShipmentRoute["kind"] = "cainiao",
): boolean {
  requireScriptSource(expectedSource);
  if (!fromId || !toId) return false;
  const routes = read();
  const value = routes[fromId];
  if (
    !value ||
    value.source !== expectedSource ||
    (value.kind || "cainiao") !== expectedKind ||
    value.updatedAtMs <= 0 ||
    value.updatedAtMs > now ||
    now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
    !trustedRoute(value.url, expectedKind)
  ) {
    return false;
  }
  if (fromId === toId) return true;
  routes[toId] = value;
  delete routes[fromId];
  write(routes);
  return true;
}

export function migrateLegacyShipmentRoutes(
  migrations: readonly LegacyShipmentRouteMigration[],
  now = Date.now(),
): void {
  if (!migrations.length) return;
  const routes = read();
  let changed = false;
  for (const migration of migrations) {
    const fromId = String(migration.fromId || "").trim();
    const toId = String(migration.toId || "").trim();
    if (!fromId || !toId) continue;
    const value = routes[fromId];
    if (
      !value ||
      (value.source !== "interface5" && value.source !== "interface6") ||
      value.updatedAtMs <= 0 ||
      value.updatedAtMs > now ||
      now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
      !trustedRoute(value.url, value.kind || "cainiao")
    ) {
      continue;
    }
    const existing = routes[toId];
    const retained: RouteValue = existing &&
        existing.source === SCRIPT_BINDING_SOURCE &&
        existing.updatedAtMs >= value.updatedAtMs &&
        existing.updatedAtMs <= now &&
        now - existing.updatedAtMs < ROUTE_MAX_AGE_MS &&
        trustedRoute(existing.url, existing.kind || "cainiao")
      ? existing
      : {
          ...value,
          source: SCRIPT_BINDING_SOURCE,
        };
    if (
      routes[toId] !== retained ||
      value.source !== SCRIPT_BINDING_SOURCE ||
      fromId !== toId
    ) {
      routes[toId] = retained;
      changed = true;
    }
    if (fromId !== toId && fromId in routes) {
      delete routes[fromId];
      changed = true;
    }
  }
  if (changed) write(routes);
}

/**
 * Applies route changes only at the caller's durable state boundary. If publishing the matching
 * state pointers fails, the original Keychain map is restored before the error is propagated.
 */
export function commitShipmentRouteMutations<T>(
  mutations: readonly ShipmentRouteMutation[],
  publish: (publications: readonly ShipmentRoutePublication[]) => T,
  now = Date.now(),
): T | null {
  if (!mutations.length) return null;
  const before = read();
  const after: RouteMap = { ...before };
  const publications: ShipmentRoutePublication[] = [];

  for (const mutation of mutations) {
    if (!mutation.key || !mutation.targetId) continue;
    if (mutation.kind === "save") {
      requireScriptSource(mutation.source);
      const routeKind = mutation.routeKind || "cainiao";
      const url = trustedRoute(mutation.url, routeKind);
      if (!url) continue;
      after[mutation.targetId] = {
        url,
        source: mutation.source,
        kind: routeKind,
        updatedAtMs: now,
      };
    } else {
      requireScriptSource(mutation.source);
      const value = after[mutation.fromId];
      if (
        !value ||
        value.source !== mutation.source ||
        value.updatedAtMs <= 0 ||
        value.updatedAtMs > now ||
        now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
        !trustedRoute(value.url, mutation.routeKind || value.kind || "cainiao")
      ) {
        continue;
      }
      if (mutation.fromId !== mutation.targetId) {
        after[mutation.targetId] = value;
        delete after[mutation.fromId];
      }
    }
    publications.push({
      key: mutation.key,
      targetId: mutation.targetId,
      source: mutation.source,
      routeKind: mutation.routeKind ||
        (after[mutation.targetId]?.kind || "cainiao"),
    });
  }

  if (!publications.length) return null;
  write(after);
  try {
    return publish(publications);
  } catch (error) {
    write(before);
    throw error;
  }
}

export function pruneShipmentRoutes(
  retainedIds: readonly string[],
  now = Date.now(),
): void {
  const retained = new Set(retainedIds);
  const routes = read(true);
  let changed = false;
  for (const [id, value] of Object.entries(routes)) {
    if (
      !retained.has(id) ||
      !value ||
      value.source !== SCRIPT_BINDING_SOURCE ||
      value.updatedAtMs <= 0 ||
      value.updatedAtMs > now ||
      now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
      !trustedRoute(value.url, value.kind || "cainiao")
    ) {
      delete routes[id];
      changed = true;
    }
  }
  if (changed) write(routes);
}
