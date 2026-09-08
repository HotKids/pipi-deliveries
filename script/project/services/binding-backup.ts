import type { AccountBinding, BindingSource } from "../models";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";
import { utf8Data } from "./scripting-data";

const BINDING_BACKUP_KEY = "pipi_deliveries_binding_backup_v1";

type BindingBackupPayload = {
  schema: 1;
  activeSource: BindingSource;
  bindings: readonly AccountBinding[];
};

type StoredBindingBackup = {
  checksum: string;
  payload: BindingBackupPayload;
};

export type BindingBackup = {
  activeSource: BindingSource;
  bindings: AccountBinding[];
};

function checksum(value: unknown): string {
  return Crypto.sha256(utf8Data(JSON.stringify(value))).toHexString();
}

function phone(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  return /^1[3-9]\d{9}$/.test(digits) ? digits : "";
}

function bindings(values: unknown): AccountBinding[] {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, AccountBinding>();
  for (const raw of values) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Partial<AccountBinding>;
    const normalizedPhone = phone(value.phone);
    if (!normalizedPhone || value.source !== SCRIPT_BINDING_SOURCE) continue;
    unique.set(normalizedPhone, {
      source: SCRIPT_BINDING_SOURCE,
      phone: normalizedPhone,
      boundAtMs:
        typeof value.boundAtMs === "number" && Number.isFinite(value.boundAtMs)
          ? value.boundAtMs
          : 0,
    });
  }
  return [...unique.values()];
}

export function loadBindingBackup(): BindingBackup | null {
  try {
    const raw = Keychain.get(BINDING_BACKUP_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredBindingBackup>;
    const payload = stored?.payload as Partial<BindingBackupPayload> | undefined;
    if (
      !payload ||
      payload.schema !== 1 ||
      !Array.isArray(payload.bindings) ||
      typeof stored.checksum !== "string" ||
      stored.checksum !== checksum(payload)
    ) return null;
    return {
      activeSource: SCRIPT_BINDING_SOURCE,
      bindings: bindings(payload.bindings),
    };
  } catch {
    return null;
  }
}

export function saveBindingBackup(
  activeSource: BindingSource,
  values: readonly AccountBinding[],
): void {
  requireScriptSource(activeSource);
  const payload: BindingBackupPayload = {
    schema: 1,
    activeSource: SCRIPT_BINDING_SOURCE,
    bindings: bindings(values),
  };
  const stored: StoredBindingBackup = {
    checksum: checksum(payload),
    payload,
  };
  try {
    const result = Keychain.set(BINDING_BACKUP_KEY, JSON.stringify(stored));
    if (result === false) throw new Error("binding backup rejected");
  } catch {
    throw new Error("手机号绑定备份失败");
  }
}
