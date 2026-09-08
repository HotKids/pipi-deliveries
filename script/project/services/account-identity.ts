import {
  readDurableTextCandidates,
  writeDurableText,
} from "./durable-files";
import { utf8Data } from "./scripting-data";
import { writeDiagnostic } from "./logger";

export type AccountSource = "interface5" | "interface6";

export type Interface5Identity = Readonly<{
  userId: string;
  oaid: string;
  vaid: string;
}>;
export type AccountIdentity = Interface5Identity;

export type IdentityStore = Readonly<{
  read: (key: string) => string;
  write: (key: string, value: string) => boolean;
}>;

export type RandomByteSource = (count: number) => readonly number[];

const INTERFACE5_IDENTITY_KEY = "pipi_deliveries_account_v5_identity_v1";
const INTERFACE5_IDENTITY_SHARED_KEY =
  "pipi_deliveries_account_v5_identity_shared_v1";
const INTERFACE5_IDENTITY_FILE = "account-identity-v1.json";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseObject(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function secureRandomBytes(count: number): number[] {
  const output: number[] = [];
  while (output.length < count) {
    const hex = Crypto.generateSymmetricKey(128).toHexString().toLowerCase();
    for (let index = 0; index + 1 < hex.length && output.length < count; index += 2) {
      const value = Number.parseInt(hex.slice(index, index + 2), 16);
      if (Number.isInteger(value)) output.push(value);
    }
  }
  return output;
}

function bytes(source: RandomByteSource, count: number): number[] {
  const values = [...source(count)];
  if (values.length < count) throw new Error("Unable to generate installation identity");
  return values.slice(0, count).map((value) => {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error("Unable to generate installation identity");
    }
    return value;
  });
}

function hex(values: readonly number[]): string {
  return values.map((value) => value.toString(16).padStart(2, "0")).join("");
}

function durableChecksum(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

function encodedIdentity(value: string): string {
  return JSON.stringify({
    schema: 1,
    checksum: durableChecksum(value),
    payload: value,
  });
}

function decodedIdentity(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const stored = object(JSON.parse(raw));
    const payload = clean(stored.payload);
    const checksum = clean(stored.checksum).toLowerCase();
    return stored.schema === 1 &&
      payload &&
      checksum === durableChecksum(payload) &&
      isInterface5Identity(parseObject(payload))
      ? payload
      : "";
  } catch {
    return "";
  }
}

function readDurableIdentity(): string {
  for (const raw of readDurableTextCandidates(INTERFACE5_IDENTITY_FILE)) {
    const payload = decodedIdentity(raw);
    if (payload) return payload;
  }
  return "";
}

function writeDurableIdentity(value: string): void {
  const parsed = parseObject(value);
  if (!isInterface5Identity(parsed)) {
    throw new Error("Installation identity could not be saved");
  }
  writeDurableText(INTERFACE5_IDENTITY_FILE, encodedIdentity(value));
}

function readSharedIdentity(): string {
  try {
    return decodedIdentity(Storage.get<string>(
      INTERFACE5_IDENTITY_SHARED_KEY,
      { shared: true },
    ));
  } catch {
    return "";
  }
}

function writeSharedIdentity(value: string): boolean {
  try {
    return Storage.set(
      INTERFACE5_IDENTITY_SHARED_KEY,
      encodedIdentity(value),
      { shared: true },
    );
  } catch {
    return false;
  }
}

function mirrorRuntimeIdentity(
  key: string,
  value: string,
  restoreDurable: boolean,
): void {
  if (restoreDurable) {
    try {
      writeDurableIdentity(value);
    } catch {
      /* another verified identity mirror remains usable */
    }
  }
  writeSharedIdentity(value);
  try {
    Keychain.set(key, value);
  } catch {
    /* durable and shared mirrors remain usable */
  }
}

function runtimeStore(onGenerated: () => void): IdentityStore {
  return {
    read(key) {
      if (key === INTERFACE5_IDENTITY_KEY) {
        const durable = readDurableIdentity();
        if (durable) {
          mirrorRuntimeIdentity(key, durable, false);
          return durable;
        }
        const shared = readSharedIdentity();
        if (shared) {
          mirrorRuntimeIdentity(key, shared, true);
          return shared;
        }
      }
      try {
        const value = Keychain.get(key);
        const restored = typeof value === "string" ? value : "";
        if (key === INTERFACE5_IDENTITY_KEY && restored) {
          mirrorRuntimeIdentity(key, restored, true);
        }
        return restored;
      } catch {
        return "";
      }
    },
    write(key, value) {
      if (key === INTERFACE5_IDENTITY_KEY) {
        try {
          writeDurableIdentity(value);
        } catch {
          return false;
        }
        writeSharedIdentity(value);
      }
      try {
        Keychain.set(key, value);
      } catch {
        /* the durable identity is sufficient after a Keychain scope replacement */
      }
      onGenerated();
      return true;
    },
  };
}

export function isInterface5Identity(value: unknown): value is Interface5Identity {
  const candidate = object(value);
  return /^\d{10}$/.test(clean(candidate.userId))
    && /^[0-9a-f]{16}$/.test(clean(candidate.oaid))
    && /^[0-9a-f]{16}$/.test(clean(candidate.vaid));
}

export function generateInterface5Identity(
  random: RandomByteSource = secureRandomBytes,
): Interface5Identity {
  const values = bytes(random, 26);
  const identity: Interface5Identity = {
    userId: values.slice(0, 10).map((value) => String(value % 10)).join(""),
    oaid: hex(values.slice(10, 18)),
    vaid: hex(values.slice(18, 26)),
  };
  if (!isInterface5Identity(identity)) {
    throw new Error("Unable to generate installation identity");
  }
  return identity;
}

export function resolveInterface5Identity(
  store: IdentityStore,
  random: RandomByteSource = secureRandomBytes,
): Interface5Identity {
  const restored = parseObject(store.read(INTERFACE5_IDENTITY_KEY));
  if (isInterface5Identity(restored)) {
    return {
      userId: clean(restored.userId),
      oaid: clean(restored.oaid),
      vaid: clean(restored.vaid),
    };
  }
  const generated = generateInterface5Identity(random);
  if (!store.write(INTERFACE5_IDENTITY_KEY, JSON.stringify(generated))) {
    throw new Error("Installation identity could not be saved");
  }
  return generated;
}

export function loadAccountIdentity(source: "interface5"): Interface5Identity {
  if (source !== "interface5") {
    throw new Error("Unsupported account source");
  }
  return resolveInterface5Identity(runtimeStore(() => {
    writeDiagnostic(
      "account.identity.generated",
      { source: "interface5", stage: "installation_identity" },
      "warning",
    );
  }));
}
