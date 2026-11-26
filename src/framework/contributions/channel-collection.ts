// ABOUTME: Persists one capability's ordered channel bindings and enforces its enable policy.
// ABOUTME: Known channels are validated and rewritten; unknown stored ids are skipped and kept.
import { signal } from "nsh";
import { t } from "nsh/i18n";
import type {
  CapabilityChannelContribution,
  ChannelBinding,
  CredentialInput,
  CredentialRecord,
  Result,
} from "./contracts";
import { createLogger } from "../../services/log";
import type { CredentialVault, VaultStorage } from "./credential-vault";

const log = createLogger("framework/channel-collection");

/** Storage version written by this framework. */
export const CHANNEL_COLLECTION_VERSION = 1;

/** One stored channel record; `config` is the raw JSON a contribution parses. */
export interface StoredChannel {
  enabled: boolean;
  configured: boolean;
  config: unknown;
  credentialRef: string | null;
}

/** The complete versioned JSON record one collection stores. */
export interface StoredCollection {
  version: number;
  order: string[];
  channels: Record<string, StoredChannel>;
}

/** Per-domain behavior a capability decides once. */
export interface ChannelCollectionPolicy {
  /** Turn a channel on the first time it is saved. */
  enableOnFirstSave: boolean;
  /** Refuse to enable a channel whose saved credential cannot be read. */
  requireReadableCredentialOnEnable?: boolean;
}

export type ChannelCollectionErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_write_failed"
  | "credential_write_failed"
  | "credential_required"
  | "credential_unreadable"
  | "channel_unconfigured"
  | "channel_not_configurable"
  | "unknown_channel"
  | "invalid_config";

export interface ChannelCollectionError {
  key: ChannelCollectionErrorKey;
  message: string;
}

const ERROR_KEYS: Record<ChannelCollectionErrorKey, string> = {
  storage_read_failed: "settings.capabilities.error.storageReadFailed",
  storage_malformed: "settings.capabilities.error.storageMalformed",
  storage_unsupported_version: "settings.capabilities.error.storageUnsupportedVersion",
  storage_write_failed: "settings.capabilities.error.storageWriteFailed",
  credential_write_failed: "settings.capabilities.error.credentialWriteFailed",
  credential_required: "settings.capabilities.error.credentialRequired",
  credential_unreadable: "settings.capabilities.error.credentialUnreadable",
  channel_unconfigured: "settings.capabilities.error.channelUnconfigured",
  channel_not_configurable: "settings.capabilities.error.channelNotConfigurable",
  unknown_channel: "settings.capabilities.error.unknownChannel",
  invalid_config: "settings.capabilities.error.invalidConfig",
};

function failure(key: ChannelCollectionErrorKey): {
  ok: false;
  key: ChannelCollectionErrorKey;
  message: string;
} {
  return { ok: false, key, message: t(ERROR_KEYS[key]) };
}

function emptyCollection(): StoredCollection {
  return { version: CHANNEL_COLLECTION_VERSION, order: [], channels: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type ErasedContribution = CapabilityChannelContribution<unknown, unknown, unknown>;

/** The shared settings host's view of one capability's channel collection. */
export interface ChannelCollection {
  readonly capability: string;
  load(): Promise<void>;
  loadError(): ChannelCollectionError | null;
  /** Visible channel ids in priority order; stored ids without a contribution are hidden. */
  order(): readonly string[];
  /** Registered ids not yet added, in registration order. */
  available(): readonly string[];
  /** Stored ids this build has no contribution for, counted on load. */
  skippedCount(): number;
  contribution(id: string): ErasedContribution | null;
  binding(id: string): ChannelBinding | null;
  isEnabled(id: string): boolean;
  activeBinding(): ChannelBinding | null;
  /** The first enabled channel in priority order, with its id. */
  activeChannel(): { id: string; binding: ChannelBinding } | null;
  add(id: string): Promise<Result>;
  save(id: string, config: unknown, credential: CredentialInput): Promise<Result>;
  setEnabled(id: string, enabled: boolean): Promise<Result>;
  moveTo(id: string, targetIndex: number): Promise<Result>;
  remove(id: string): Promise<Result>;
  readCredential(credentialRef: string | null): Promise<CredentialRecord | null>;
  describe(id: string): string;
}

export interface ChannelCollectionOptions {
  capability: string;
  storage: VaultStorage;
  storageKey: string;
  vault: CredentialVault;
  /** Read lazily so startup assembly can register contributions after the store exists. */
  contributions: () => readonly ErasedContribution[];
  policy: ChannelCollectionPolicy;
}

function isVisibleRecord(value: unknown): value is StoredChannel {
  if (!isPlainObject(value)) return false;
  if (typeof value.enabled !== "boolean" || typeof value.configured !== "boolean") return false;
  if (value.credentialRef !== null && typeof value.credentialRef !== "string") return false;
  return "config" in value;
}

type ParsedCollection =
  | { ok: true; record: StoredCollection }
  | { ok: false; key: ChannelCollectionErrorKey };

function parseCollection(raw: string): ParsedCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, key: "storage_malformed" };
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== "number") {
    return { ok: false, key: "storage_malformed" };
  }
  if (parsed.version !== CHANNEL_COLLECTION_VERSION) {
    return { ok: false, key: "storage_unsupported_version" };
  }
  const order = parsed.order;
  if (!Array.isArray(order)) return { ok: false, key: "storage_malformed" };
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      return { ok: false, key: "storage_malformed" };
    }
    seen.add(id);
  }
  if (!isPlainObject(parsed.channels)) return { ok: false, key: "storage_malformed" };
  const channels: Record<string, StoredChannel> = {};
  for (const [id, value] of Object.entries(parsed.channels)) {
    if (!seen.has(id) || !isVisibleRecord(value)) return { ok: false, key: "storage_malformed" };
    channels[id] = {
      enabled: value.enabled,
      configured: value.configured,
      config: value.config,
      credentialRef: value.credentialRef,
    };
  }
  if (Object.keys(channels).length !== order.length) {
    return { ok: false, key: "storage_malformed" };
  }
  return { ok: true, record: { version: CHANNEL_COLLECTION_VERSION, order, channels } };
}

function serialize(record: StoredCollection): string {
  return JSON.stringify({
    version: CHANNEL_COLLECTION_VERSION,
    order: record.order,
    channels: record.channels,
  });
}

/** Creates one capability's channel collection over injected storage and vault. */
export function createChannelCollection(options: ChannelCollectionOptions): ChannelCollection {
  const { capability, storage, storageKey, vault, contributions, policy } = options;
  const stateSignal = signal<StoredCollection>(emptyCollection());
  const errorSignal = signal<ChannelCollectionError | null>(null);
  const skippedSignal = signal(0);
  let writeQueue: Promise<unknown> = Promise.resolve();

  function contributionOf(id: string): ErasedContribution | null {
    return contributions().find((entry) => entry.id === id) ?? null;
  }

  function knownOrder(record: StoredCollection): string[] {
    return record.order.filter((id) => contributionOf(id) !== null);
  }

  function bindingOf(record: StoredCollection, id: string): ChannelBinding | null {
    const stored = record.channels[id];
    if (stored === undefined) return null;
    const contribution = contributionOf(id);
    if (contribution === null) return null;
    const config = contribution.config.parse(stored.config) ?? contribution.config.defaults();
    return {
      enabled: stored.enabled,
      configured: stored.configured,
      config,
      credentialRef: stored.credentialRef,
    };
  }

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(task);
    writeQueue = queued.catch(() => undefined);
    return queued;
  }

  function countSkipped(record: StoredCollection): number {
    return record.order.filter((id) => contributionOf(id) === null).length;
  }

  function persist(record: StoredCollection): Promise<Result> {
    return (async () => {
      try {
        await storage.setItem(storageKey, serialize(record));
      } catch {
        return failure("storage_write_failed");
      }
      stateSignal.set(clone(record));
      errorSignal.set(null);
      skippedSignal.set(countSkipped(record));
      return { ok: true as const };
    })();
  }

  async function discardCredential(ref: string | null): Promise<void> {
    if (ref === null) return;
    try {
      await vault.remove(ref);
    } catch {
      log.warn("Could not remove an unused channel credential.");
    }
  }

  async function readableCredential(ref: string | null): Promise<boolean> {
    if (ref === null) return false;
    try {
      return (await vault.read(ref)) !== null;
    } catch {
      return false;
    }
  }

  return {
    capability,
    load: async () => {
      let raw: string | null;
      try {
        raw = await storage.getItem(storageKey);
      } catch {
        stateSignal.set(emptyCollection());
        skippedSignal.set(0);
        errorSignal.set(failure("storage_read_failed"));
        return;
      }
      if (raw === null) {
        stateSignal.set(emptyCollection());
        skippedSignal.set(0);
        errorSignal.set(null);
        return;
      }
      const parsed = parseCollection(raw);
      if (!parsed.ok) {
        stateSignal.set(emptyCollection());
        skippedSignal.set(0);
        errorSignal.set(failure(parsed.key));
        return;
      }
      for (const id of parsed.record.order) {
        const contribution = contributionOf(id);
        if (contribution === null) continue;
        if (contribution.config.parse(parsed.record.channels[id]?.config) === null) {
          stateSignal.set(emptyCollection());
          skippedSignal.set(0);
          errorSignal.set(failure("storage_malformed"));
          return;
        }
      }
      stateSignal.set(clone(parsed.record));
      skippedSignal.set(countSkipped(parsed.record));
      errorSignal.set(null);
    },
    loadError: () => errorSignal(),
    order: () => knownOrder(stateSignal()),
    available: () => {
      const added = new Set(stateSignal().order);
      return contributions()
        .filter((entry) => !added.has(entry.id))
        .map((entry) => entry.id);
    },
    skippedCount: () => skippedSignal(),
    contribution: (id) => contributionOf(id),
    binding: (id) => bindingOf(stateSignal(), id),
    isEnabled: (id) => stateSignal().channels[id]?.enabled === true,
    activeChannel: () => {
      const record = stateSignal();
      for (const id of knownOrder(record)) {
        const binding = bindingOf(record, id);
        if (binding?.enabled === true) return { id, binding };
      }
      return null;
    },
    activeBinding: () => {
      const record = stateSignal();
      for (const id of knownOrder(record)) {
        const binding = bindingOf(record, id);
        if (binding?.enabled === true) return binding;
      }
      return null;
    },
    add: (id) =>
      enqueueWrite(async () => {
        const contribution = contributionOf(id);
        if (contribution === null) return failure("unknown_channel");
        const current = clone(stateSignal());
        if (current.order.includes(id)) return { ok: true as const };
        current.order = [...current.order, id];
        current.channels[id] = {
          enabled: !contribution.configurable,
          configured: !contribution.configurable,
          config: contribution.config.defaults(),
          credentialRef: null,
        };
        return persist(current);
      }),
    save: (id, config, credential) =>
      enqueueWrite(async () => {
        const contribution = contributionOf(id);
        if (contribution === null) return failure("unknown_channel");
        if (!contribution.configurable) return failure("channel_not_configurable");
        const parsedConfig = contribution.config.parse(config);
        if (parsedConfig === null) return failure("invalid_config");
        const current = clone(stateSignal());
        const existing = current.channels[id] ?? null;
        const previousRef = existing?.credentialRef ?? null;
        if (!current.order.includes(id)) current.order = [...current.order, id];

        let credentialRef: string | null;
        let wroteCredential = false;
        if (credential.mode === "keep") {
          credentialRef = previousRef;
        } else if (credential.mode === "clear") {
          credentialRef = null;
        } else {
          const hasValue = Object.values(credential.value).some(
            (value) => typeof value === "string" && value.trim().length > 0,
          );
          if (!hasValue) return failure("credential_required");
          try {
            credentialRef = await vault.put(credential.value);
          } catch {
            return failure("credential_write_failed");
          }
          wroteCredential = true;
        }

        let enabled = existing?.enabled === true;
        if (!enabled && policy.enableOnFirstSave && existing?.configured !== true) {
          const requiresCredential =
            policy.requireReadableCredentialOnEnable === true && contribution.credential !== null;
          if (requiresCredential && !(await readableCredential(credentialRef))) {
            if (wroteCredential) await discardCredential(credentialRef);
            return failure("credential_unreadable");
          }
          enabled = true;
        }

        current.channels[id] = {
          enabled,
          configured: true,
          config: parsedConfig,
          credentialRef,
        };
        const written = await persist(current);
        if (!written.ok) {
          if (wroteCredential) await discardCredential(credentialRef);
          return written;
        }
        if (credentialRef !== previousRef) await discardCredential(previousRef);
        return { ok: true as const };
      }),
    setEnabled: (id, enabled) =>
      enqueueWrite(async () => {
        const current = clone(stateSignal());
        const stored = current.channels[id] ?? null;
        if (stored === null || !stored.configured) return failure("channel_unconfigured");
        if (stored.enabled === enabled) return { ok: true as const };
        const contribution = contributionOf(id);
        if (contribution === null) return failure("unknown_channel");
        if (
          enabled &&
          policy.requireReadableCredentialOnEnable === true &&
          contribution.credential !== null &&
          !(await readableCredential(stored.credentialRef))
        ) {
          return failure("credential_unreadable");
        }
        current.channels[id] = { ...stored, enabled };
        return persist(current);
      }),
    moveTo: (id, targetIndex) =>
      enqueueWrite(async () => {
        const current = clone(stateSignal());
        const visible = knownOrder(current);
        const from = visible.indexOf(id);
        if (from === -1) return { ok: true as const };
        const requested = Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : from;
        const target = Math.min(Math.max(requested, 0), visible.length - 1);
        if (target === from) return { ok: true as const };
        const anchor = visible[target] ?? null;
        const order = current.order.filter((entry) => entry !== id);
        const anchorIndex = anchor === null ? -1 : order.indexOf(anchor);
        const insertion =
          anchorIndex === -1 ? order.length : target > from ? anchorIndex + 1 : anchorIndex;
        order.splice(insertion, 0, id);
        current.order = order;
        return persist(current);
      }),
    remove: (id) =>
      enqueueWrite(async () => {
        const current = clone(stateSignal());
        if (!current.order.includes(id)) return { ok: true as const };
        const removed = current.channels[id] ?? null;
        current.order = current.order.filter((entry) => entry !== id);
        delete current.channels[id];
        const written = await persist(current);
        if (written.ok) await discardCredential(removed?.credentialRef ?? null);
        return written;
      }),
    readCredential: async (credentialRef) => {
      if (credentialRef === null) return null;
      try {
        return await vault.read(credentialRef);
      } catch {
        return null;
      }
    },
    describe: (id) => {
      const binding = bindingOf(stateSignal(), id);
      const contribution = contributionOf(id);
      if (binding === null || contribution === null) return "";
      return contribution.describe(binding);
    },
  };
}
