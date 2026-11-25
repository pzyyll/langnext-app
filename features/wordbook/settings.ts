import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

const STORAGE_KEY = "settings.wordbook.anki.v1";
const CREDENTIAL_PREFIX = "settings.wordbook.anki.credentials.";
const STORAGE_VERSION = 1;
const ENTITY_ID = /^[1-9][0-9]{0,18}$/;
const MAX_ENTITY_ID = 9223372036854775807n;
const log = createLogger("wordbook/settings");

export interface WordbookSettingsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface WordbookAnkiTarget {
  profile: string;
  deckId: string;
  deckName: string;
  noteTypeId: string;
  noteTypeName: string;
  sourceField: string;
  translationField: string;
  credentialRef?: string;
}

export type WordbookSettingsErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_write_failed"
  | "target_incomplete"
  | "credential_unreadable";

export interface WordbookSettingsError {
  key: WordbookSettingsErrorKey;
  message: string;
}

export interface WordbookSettingsSnapshot {
  target: WordbookAnkiTarget | null;
  enabled: boolean;
  error: WordbookSettingsError | null;
}

export type WordbookSettingsResult =
  | { ok: true }
  | { ok: false; key: WordbookSettingsErrorKey; message: string };

export interface WordbookCredentialChange {
  /** A non-blank value replaces the saved key. Blank keeps it. */
  apiKey?: string;
  /** Removes the saved key after the binding no longer references it. */
  removeKey?: boolean;
}

const ERROR_MESSAGES: Record<WordbookSettingsErrorKey, string> = {
  storage_read_failed: "settings.wordbook.error.storageReadFailed",
  storage_malformed: "settings.wordbook.error.storageMalformed",
  storage_write_failed: "settings.wordbook.error.storageWriteFailed",
  target_incomplete: "settings.wordbook.error.targetIncomplete",
  credential_unreadable: "settings.wordbook.error.credentialUnreadable",
};

function failure(key: WordbookSettingsErrorKey): WordbookSettingsResult {
  return { ok: false, key, message: t(ERROR_MESSAGES[key]) };
}

function errorOf(key: WordbookSettingsErrorKey): WordbookSettingsError {
  return { key, message: t(ERROR_MESSAGES[key]) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntityId(value: string): boolean {
  return ENTITY_ID.test(value) && BigInt(value) <= MAX_ENTITY_ID;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function copyTarget(target: WordbookAnkiTarget): WordbookAnkiTarget {
  return {
    profile: target.profile,
    deckId: target.deckId,
    deckName: target.deckName,
    noteTypeId: target.noteTypeId,
    noteTypeName: target.noteTypeName,
    sourceField: target.sourceField,
    translationField: target.translationField,
    ...(target.credentialRef ? { credentialRef: target.credentialRef } : {}),
  };
}

function complete(target: WordbookAnkiTarget): boolean {
  return (
    text(target.profile) !== null &&
    isEntityId(target.deckId) &&
    text(target.deckName) !== null &&
    isEntityId(target.noteTypeId) &&
    text(target.noteTypeName) !== null &&
    text(target.sourceField) !== null &&
    text(target.translationField) !== null &&
    target.sourceField !== target.translationField &&
    (target.credentialRef === undefined || text(target.credentialRef) !== null)
  );
}

function parseStored(
  raw: string,
): { ok: true; target: WordbookAnkiTarget; enabled: boolean } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) return { ok: false };
  const profile = text(parsed.profile);
  const deckId = text(parsed.deckId);
  const deckName = text(parsed.deckName);
  const noteTypeId = text(parsed.noteTypeId);
  const noteTypeName = text(parsed.noteTypeName);
  const sourceField = text(parsed.sourceField);
  const translationField = text(parsed.translationField);
  if (
    !profile ||
    !deckId ||
    !isEntityId(deckId) ||
    !deckName ||
    !noteTypeId ||
    !isEntityId(noteTypeId) ||
    !noteTypeName ||
    !sourceField ||
    !translationField ||
    sourceField === translationField
  ) {
    return { ok: false };
  }
  const credential = parsed.credentialRef;
  if (credential !== undefined && text(credential) === null) return { ok: false };
  const target: WordbookAnkiTarget = {
    profile,
    deckId,
    deckName,
    noteTypeId,
    noteTypeName,
    sourceField,
    translationField,
    ...(typeof credential === "string" ? { credentialRef: credential } : {}),
  };
  const enabled = parsed.enabled === undefined ? false : parsed.enabled;
  if (typeof enabled !== "boolean") return { ok: false };
  return { ok: true, target, enabled };
}

function credentialKey(ref: string): string {
  return CREDENTIAL_PREFIX + ref;
}

function withoutCredential(target: WordbookAnkiTarget): WordbookAnkiTarget {
  return {
    profile: target.profile,
    deckId: target.deckId,
    deckName: target.deckName,
    noteTypeId: target.noteTypeId,
    noteTypeName: target.noteTypeName,
    sourceField: target.sourceField,
    translationField: target.translationField,
  };
}

function payload(target: WordbookAnkiTarget, enabled: boolean): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    enabled,
    profile: target.profile,
    deckId: target.deckId,
    deckName: target.deckName,
    noteTypeId: target.noteTypeId,
    noteTypeName: target.noteTypeName,
    sourceField: target.sourceField,
    translationField: target.translationField,
    ...(target.credentialRef ? { credentialRef: target.credentialRef } : {}),
  });
}

/** Loads and saves one Anki destination. It never contacts Anki. */
export function createWordbookSettingsStore(storage: WordbookSettingsStorage) {
  let target: WordbookAnkiTarget | null = null;
  let enabled = false;
  let error: WordbookSettingsError | null = null;

  function clearTo(nextError: WordbookSettingsError | null) {
    target = null;
    enabled = false;
    error = nextError;
  }

  function snapshot(): WordbookSettingsSnapshot {
    return {
      target: target ? copyTarget(target) : null,
      enabled,
      error: error ? { ...error } : null,
    };
  }

  async function readCredential(ref: string): Promise<string | null> {
    try {
      const raw = await storage.getItem(credentialKey(ref));
      if (raw === null) return null;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (cause) {
      log.warn("Could not read the saved Anki key.", cause);
      return null;
    }
  }

  async function removeCredential(ref: string): Promise<void> {
    try {
      await storage.removeItem(credentialKey(ref));
    } catch (cause) {
      log.warn("Could not remove an unused Anki key.", cause);
    }
  }

  async function write(
    next: WordbookAnkiTarget,
    nextEnabled: boolean,
  ): Promise<WordbookSettingsResult> {
    try {
      await storage.setItem(STORAGE_KEY, payload(next, nextEnabled));
    } catch (cause) {
      log.warn("Could not save the Wordbook settings.", cause);
      return failure("storage_write_failed");
    }
    target = copyTarget(next);
    enabled = nextEnabled;
    error = null;
    return { ok: true };
  }

  return {
    async load(): Promise<WordbookSettingsSnapshot> {
      let raw: string | null;
      try {
        raw = await storage.getItem(STORAGE_KEY);
      } catch (cause) {
        log.warn("Could not read the Wordbook settings.", cause);
        clearTo(errorOf("storage_read_failed"));
        return snapshot();
      }
      if (raw === null) {
        clearTo(null);
        return snapshot();
      }
      const parsed = parseStored(raw);
      if (!parsed.ok) {
        clearTo(errorOf("storage_malformed"));
        return snapshot();
      }
      target = parsed.target;
      enabled = parsed.enabled;
      error = null;
      if (parsed.target.credentialRef) {
        const secret = await readCredential(parsed.target.credentialRef);
        if (secret === null) error = errorOf("credential_unreadable");
      }
      return snapshot();
    },
    async save(
      next: WordbookAnkiTarget,
      change?: WordbookCredentialChange,
    ): Promise<WordbookSettingsResult> {
      const fields = withoutCredential(next);
      if (!complete(fields)) return failure("target_incomplete");
      const keepEnabled = enabled && target !== null;
      const previousRef = target?.credentialRef;
      if (change?.removeKey) {
        const written = await write(fields, keepEnabled);
        if (written.ok && previousRef) await removeCredential(previousRef);
        return written;
      }
      const trimmed = change?.apiKey?.trim() ?? "";
      if (trimmed.length === 0) {
        return write(previousRef ? { ...fields, credentialRef: previousRef } : fields, keepEnabled);
      }
      const credentialRef = crypto.randomUUID();
      try {
        await storage.setItem(credentialKey(credentialRef), trimmed);
      } catch (cause) {
        log.warn("Could not save the Anki key.", cause);
        return failure("storage_write_failed");
      }
      const written = await write({ ...fields, credentialRef }, keepEnabled);
      if (!written.ok) {
        await removeCredential(credentialRef);
        return written;
      }
      if (previousRef && previousRef !== credentialRef) await removeCredential(previousRef);
      return written;
    },
    async setEnabled(nextEnabled: boolean): Promise<WordbookSettingsResult> {
      if (!target || !complete(target)) return failure("target_incomplete");
      if (!nextEnabled) return write(target, false);
      if (target.credentialRef) {
        const secret = await readCredential(target.credentialRef);
        if (secret === null) {
          error = errorOf("credential_unreadable");
          return failure("credential_unreadable");
        }
      }
      return write(target, true);
    },
    activeBinding(): WordbookAnkiTarget | null {
      if (!enabled || !target || error || !complete(target)) return null;
      return copyTarget(target);
    },
  };
}
