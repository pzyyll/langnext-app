import { signal, Storage } from "nsh";
import { t } from "nsh/i18n";
import { createLogger } from "../../services/log";

export const GOOGLE_CLOUD_USAGE_STORAGE_PREFIX = "presets.v1.googleCloudUsage.";
const STORAGE_VERSION = 1;
const MONTH_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const log = createLogger("presets/google-cloud-usage");

/** One preset's locally counted Google Cloud translation usage for one month. */
export interface GoogleCloudUsage {
  /** Local calendar month in `YYYY-MM` form; the count starts over when it changes. */
  month: string;
  characters: number;
}

export type GoogleCloudUsageState =
  | { kind: "loading" }
  | { kind: "ready"; usage: GoogleCloudUsage }
  | { kind: "error"; message: string };

export interface GoogleCloudUsageStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface GoogleCloudUsageStore {
  /** One preset's read; `null` when no read has started. */
  state(presetId: string): GoogleCloudUsageState | null;
  /** Reads a preset's count once; `refresh` reads it again even when a value is cached. */
  load(presetId: string, options?: { refresh?: boolean }): Promise<void>;
  /** Adds one request's characters to the preset's current month. Never rejects. */
  record(presetId: string, characters: number): Promise<void>;
}

/** Storage key for one preset's monthly usage. */
export function googleCloudUsageStorageKey(presetId: string): string {
  return `${GOOGLE_CLOUD_USAGE_STORAGE_PREFIX}${presetId}`;
}

/** Local calendar month of `date` in `YYYY-MM` form; the count resets on the 1st. */
export function usageMonthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** First instant of the month after `date`, in local time. */
export function nextUsageReset(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

/** Counts source characters as Unicode code points. */
export function countUsageCharacters(text: string): number {
  return [...text].length;
}

function parseStoredUsage(raw: string | null): GoogleCloudUsage | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION) return null;
  if (typeof record.month !== "string" || !MONTH_KEY_PATTERN.test(record.month)) return null;
  const characters = record.characters;
  if (typeof characters !== "number" || !Number.isSafeInteger(characters) || characters < 0) {
    return null;
  }
  return { month: record.month, characters };
}

/** Creates a monthly usage store over one storage and one local clock. */
export function createGoogleCloudUsageStore(
  storage: GoogleCloudUsageStorage,
  now: () => Date = () => new Date(),
): GoogleCloudUsageStore {
  const statesSignal = signal<Record<string, GoogleCloudUsageState>>({});
  const pendingReads = new Map<string, Promise<void>>();
  const writeQueues = new Map<string, Promise<void>>();

  const setState = (presetId: string, state: GoogleCloudUsageState | null) => {
    const next = { ...statesSignal() };
    if (state === null) {
      delete next[presetId];
    } else {
      next[presetId] = state;
    }
    statesSignal.set(next);
  };

  const readCurrentMonth = async (presetId: string): Promise<GoogleCloudUsage> => {
    const month = usageMonthKey(now());
    const stored = parseStoredUsage(await storage.getItem(googleCloudUsageStorageKey(presetId)));
    return stored && stored.month === month ? stored : { month, characters: 0 };
  };

  const load = (presetId: string, options: { refresh?: boolean } = {}) => {
    const running = pendingReads.get(presetId);
    if (running) return running;
    const cached = statesSignal()[presetId];
    if (!options.refresh && cached?.kind === "ready") return Promise.resolve();

    const run = (async () => {
      setState(presetId, { kind: "loading" });
      try {
        const usage = await readCurrentMonth(presetId);
        setState(presetId, { kind: "ready", usage });
      } catch (error) {
        log.warn("Could not read Google Cloud character usage.", error);
        setState(presetId, { kind: "error", message: t("presets.googleCloud.usage.unreadable") });
      }
    })();

    pendingReads.set(presetId, run);
    void run.then(() => {
      if (pendingReads.get(presetId) === run) pendingReads.delete(presetId);
    });
    return run;
  };

  const applyRecord = async (presetId: string, characters: number) => {
    const month = usageMonthKey(now());
    const stored = parseStoredUsage(await storage.getItem(googleCloudUsageStorageKey(presetId)));
    const total = (stored && stored.month === month ? stored.characters : 0) + characters;
    await storage.setItem(
      googleCloudUsageStorageKey(presetId),
      JSON.stringify({ version: STORAGE_VERSION, month, characters: total }),
    );
    setState(presetId, { kind: "ready", usage: { month, characters: total } });
  };

  const record = (presetId: string, characters: number): Promise<void> => {
    if (!Number.isSafeInteger(characters) || characters <= 0) return Promise.resolve();

    const previous = writeQueues.get(presetId) ?? Promise.resolve();
    const run = previous
      .then(
        () => applyRecord(presetId, characters),
        () => applyRecord(presetId, characters),
      )
      .catch((error) => {
        log.warn("Could not record Google Cloud character usage.", error);
      });

    writeQueues.set(presetId, run);
    void run.then(() => {
      if (writeQueues.get(presetId) === run) writeQueues.delete(presetId);
    });
    return run;
  };

  return {
    state: (presetId) => statesSignal()[presetId] ?? null,
    load,
    record,
  };
}

/** Production usage store backed by NSH Storage and the device's local calendar. */
export const googleCloudUsageStore = createGoogleCloudUsageStore(Storage);
