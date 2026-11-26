// ABOUTME: Stores channel credentials by opaque reference and never logs a value.
// ABOUTME: A missing record is `null`; a storage read failure rejects so callers can tell them apart.
import type { CredentialRecord } from "./contracts";

/** The storage slice the vault needs; NSH `Storage` satisfies it. */
export interface VaultStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Reads and writes one channel's credential record by its non-secret reference. */
export interface CredentialVault {
  /** Writes the non-empty fields and resolves with the reference the record is stored under. */
  put(record: CredentialRecord): Promise<string>;
  /** Resolves with the record, `null` when missing or malformed; rejects only on storage failure. */
  read(ref: string): Promise<CredentialRecord | null>;
  remove(ref: string): Promise<void>;
}

/** Prefix of one record's storage key: `<namespace>.<ref>`. */
export function credentialStorageKey(namespace: string, ref: string): string {
  return `${namespace}.${ref}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedFields(record: CredentialRecord): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) fields[key] = trimmed;
  }
  return fields;
}

/** Creates a vault over injected storage under one namespace. */
export function createCredentialVault(options: {
  storage: VaultStorage;
  namespace: string;
}): CredentialVault {
  const { storage, namespace } = options;

  return {
    put: async (record) => {
      const ref = crypto.randomUUID();
      await storage.setItem(
        credentialStorageKey(namespace, ref),
        JSON.stringify(trimmedFields(record)),
      );
      return ref;
    },
    read: async (ref) => {
      const raw = await storage.getItem(credentialStorageKey(namespace, ref));
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isPlainObject(parsed)) return null;
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") return null;
        record[key] = value;
      }
      return record;
    },
    remove: async (ref) => {
      await storage.removeItem(credentialStorageKey(namespace, ref));
    },
  };
}
