import type { BindingSource } from "../models";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";

const ROUTES_KEY = "pipi_deliveries_routes_v1";
const ORDER_PROJECTION_REFS_KEY =
  "pipi_deliveries_order_projection_refs_v1";
const ROUTE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_ROUTE_LENGTH = 16_384;

type RouteValue = {
  url: string;
  source: BindingSource;
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
      url: string;
    }
  | {
      key: string;
      kind: "move";
      fromId: string;
      targetId: string;
      source: BindingSource;
    };

export type ShipmentRoutePublication = {
  key: string;
  targetId: string;
  source: BindingSource;
};

export type LegacyShipmentRouteMigration = {
  fromId: string;
  toId: string;
};

function trustedRoute(value: string): string {
  const clean = String(value || "").trim();
  if (!/^https:\/\//i.test(clean) || clean.length > MAX_ROUTE_LENGTH) return "";
  try {
    const parsed = new URL(clean);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "cainiao.com" ||
      host.endsWith(".cainiao.com") ||
      host === "taobao.com" ||
      host.endsWith(".taobao.com")
    ) {
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

function readOrderProjectionRefs(): RouteMapRead {
  try {
    const raw = Keychain.get(ORDER_PROJECTION_REFS_KEY);
    if (!raw) return { values: {}, dirty: false };
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
    return { values, dirty };
  } catch {
    return { values: {}, dirty: true };
  }
}

function writeOrderProjectionRefs(value: RouteMap): void {
  try {
    if (!Keychain.set(ORDER_PROJECTION_REFS_KEY, JSON.stringify(value))) {
      throw new Error("订单详情保存失败，请重试");
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("订单详情保存失败，请重试");
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
  const read = readOrderProjectionRefs();
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

function read(): RouteMap {
  try {
    const raw = Keychain.get(ROUTES_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as RouteMap)
      : {};
  } catch {
    return {};
  }
}

function write(value: RouteMap): void {
  try {
    if (!Keychain.set(ROUTES_KEY, JSON.stringify(value))) {
      throw new Error("快递详情保存失败，请重试");
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("快递详情保存失败，请重试");
  }
}

export function saveShipmentRoute(
  shipmentId: string,
  source: BindingSource,
  url: string,
  now = Date.now(),
): boolean {
  requireScriptSource(source);
  const trusted = trustedRoute(url);
  if (!shipmentId || !trusted) return false;
  const routes = read();
  routes[shipmentId] = { url: trusted, source, updatedAtMs: now };
  write(routes);
  return true;
}

export function loadShipmentRoute(
  shipmentId: string,
  expectedSource: BindingSource,
  now = Date.now(),
): string {
  requireScriptSource(expectedSource);
  const value = read()[shipmentId];
  if (
    !value ||
    value.source !== expectedSource ||
    value.updatedAtMs <= 0 ||
    value.updatedAtMs > now ||
    now - value.updatedAtMs >= ROUTE_MAX_AGE_MS
  ) {
    return "";
  }
  return trustedRoute(value.url);
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
): boolean {
  requireScriptSource(expectedSource);
  if (!fromId || !toId) return false;
  const routes = read();
  const value = routes[fromId];
  if (
    !value ||
    value.source !== expectedSource ||
    value.updatedAtMs <= 0 ||
    value.updatedAtMs > now ||
    now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
    !trustedRoute(value.url)
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
      !trustedRoute(value.url)
    ) {
      continue;
    }
    const existing = routes[toId];
    const retained: RouteValue = existing &&
        existing.source === SCRIPT_BINDING_SOURCE &&
        existing.updatedAtMs >= value.updatedAtMs &&
        existing.updatedAtMs <= now &&
        now - existing.updatedAtMs < ROUTE_MAX_AGE_MS &&
        trustedRoute(existing.url)
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
      const url = trustedRoute(mutation.url);
      if (!url) continue;
      after[mutation.targetId] = {
        url,
        source: mutation.source,
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
        !trustedRoute(value.url)
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
  const routes = read();
  let changed = false;
  for (const [id, value] of Object.entries(routes)) {
    if (
      !retained.has(id) ||
      !value ||
      value.source !== SCRIPT_BINDING_SOURCE ||
      value.updatedAtMs <= 0 ||
      value.updatedAtMs > now ||
      now - value.updatedAtMs >= ROUTE_MAX_AGE_MS ||
      !trustedRoute(value.url)
    ) {
      delete routes[id];
      changed = true;
    }
  }
  if (changed) write(routes);
}
