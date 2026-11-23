import { signal } from "nsh";
import { t } from "nsh/i18n";
import { createDeepLClient, type DeepLUsage } from "../../modules/deepl/client";
import { presetsStore } from "./store";

/** One preset's usage read; `null` when no read has started. */
export type DeepLUsageState =
  | { kind: "loading" }
  | { kind: "ready"; usage: DeepLUsage }
  | { kind: "error"; message: string };

export interface DeepLUsageStore {
  state(presetId: string): DeepLUsageState | null;
  /** Reads usage once per preset; `refresh` asks DeepL again even when a value is cached. */
  load(presetId: string, options?: { refresh?: boolean }): Promise<void>;
  /** Drops a cached value and ignores a read in flight, e.g. after the key changed. */
  forget(presetId: string): void;
  /** Reads usage again, discarding a cached value or a read in flight. */
  reload(presetId: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("deepl.error.invalidResponse");
}

/** Creates a usage reader over one credential source and one DeepL transport. */
export function createDeepLUsageStore(
  readCredential: (presetId: string) => Promise<string | null>,
  fetchUsage: (apiKey: string) => Promise<DeepLUsage>,
): DeepLUsageStore {
  const statesSignal = signal<Record<string, DeepLUsageState>>({});
  const pending = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();

  const generation = (presetId: string) => generations.get(presetId) ?? 0;

  const setState = (presetId: string, state: DeepLUsageState | null) => {
    const next = { ...statesSignal() };
    if (state === null) {
      delete next[presetId];
    } else {
      next[presetId] = state;
    }
    statesSignal.set(next);
  };

  const load = (presetId: string, options: { refresh?: boolean } = {}) => {
    const running = pending.get(presetId);
    if (running) return running;
    const cached = statesSignal()[presetId];
    if (!options.refresh && cached?.kind === "ready") return Promise.resolve();

    const token = generation(presetId);
    const run = (async () => {
      setState(presetId, { kind: "loading" });
      try {
        const apiKey = await readCredential(presetId);
        if (generation(presetId) !== token) return;
        if (apiKey === null) {
          setState(presetId, { kind: "error", message: t("presets.deepl.usage.missingKey") });
          return;
        }
        const usage = await fetchUsage(apiKey);
        if (generation(presetId) !== token) return;
        setState(presetId, { kind: "ready", usage });
      } catch (error) {
        if (generation(presetId) !== token) return;
        setState(presetId, { kind: "error", message: errorMessage(error) });
      }
    })();

    pending.set(presetId, run);
    void run.then(() => {
      if (pending.get(presetId) === run) pending.delete(presetId);
    });
    return run;
  };

  const forget = (presetId: string) => {
    generations.set(presetId, generation(presetId) + 1);
    pending.delete(presetId);
    setState(presetId, null);
  };

  return {
    state: (presetId) => statesSignal()[presetId] ?? null,
    load,
    forget,
    reload: (presetId) => {
      forget(presetId);
      return load(presetId);
    },
  };
}

const client = createDeepLClient();

/** Production usage store: reads each DeepL preset's stored key and asks its host. */
export const deepLUsageStore = createDeepLUsageStore(
  (presetId) => presetsStore.readDeepLCredential(presetId),
  (apiKey) => client.getUsage({ apiKey }),
);
