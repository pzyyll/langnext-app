import { batch, signal, Storage, windowSize } from "nsh";

export type SplitPageId = "models" | "presets";

export const SIDEBAR_WIDTH = 52;
export const MIN_RAIL_WIDTH = 180;
export const DEFAULT_RAIL_WIDTH = 240;
export const COMPACT_RAIL_WIDTH = 192;
export const MAX_RAIL_WIDTH = 360;
export const MIN_DETAIL_WIDTH = 400;
const COMPACT_BREAKPOINT = 860;

export const SPLIT_RAIL_STORAGE_KEYS: Record<SplitPageId, string> = {
  models: "split.models.railWidth",
  presets: "split.presets.railWidth",
};

export interface SplitRailStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Clamps a user-chosen rail width to the supported storage bounds. */
export function clampStoredRailWidth(width: number): number {
  return Math.round(Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, width)));
}

/** Parses a persisted rail width string, ignoring invalid or non-positive values. */
export function parseRailWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return clampStoredRailWidth(parsed);
}

/** Computes the maximum rail width allowed for a given window width without squeezing the detail pane. */
export function maxRailWidthForWindow(windowWidth: number): number {
  const available = Math.max(0, windowWidth - SIDEBAR_WIDTH);
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, available - MIN_DETAIL_WIDTH));
}

/** Resolves the effective rail width for a window width, clamping without losing the saved preference. */
export function resolveRailWidth(savedWidth: number | null, windowWidth: number): number {
  const base =
    savedWidth ?? (windowWidth < COMPACT_BREAKPOINT ? COMPACT_RAIL_WIDTH : DEFAULT_RAIL_WIDTH);
  return Math.min(maxRailWidthForWindow(windowWidth), Math.max(MIN_RAIL_WIDTH, base));
}

/** Creates an isolated store managing per-page split rail widths and persistence. */
export function createSplitRailStore(storage: SplitRailStorage) {
  const modelsWidth = signal<number | null>(null);
  const presetsWidth = signal<number | null>(null);
  const widthSignalFor = (page: SplitPageId) => (page === "models" ? modelsWidth : presetsWidth);

  async function load(): Promise<void> {
    try {
      const [modelsRaw, presetsRaw] = await Promise.all([
        storage.getItem(SPLIT_RAIL_STORAGE_KEYS.models),
        storage.getItem(SPLIT_RAIL_STORAGE_KEYS.presets),
      ]);
      batch(() => {
        modelsWidth.set(parseRailWidth(modelsRaw));
        presetsWidth.set(parseRailWidth(presetsRaw));
      });
    } catch (error) {
      console.warn("Could not load split rail widths.", error);
    }
  }

  async function save(page: SplitPageId, width: number): Promise<void> {
    if (!Number.isFinite(width) || width <= 0) return;
    const clamped = clampStoredRailWidth(width);
    widthSignalFor(page).set(clamped);
    try {
      await storage.setItem(SPLIT_RAIL_STORAGE_KEYS[page], String(clamped));
    } catch (error) {
      console.warn("Could not persist split rail width.", error);
    }
  }

  return {
    load,
    save,
    savedWidth: (page: SplitPageId) => widthSignalFor(page)(),
    widthFor: (page: SplitPageId, windowWidth = windowSize().width) =>
      resolveRailWidth(widthSignalFor(page)(), windowWidth),
    maxWidthForWindow: (windowWidth = windowSize().width) => maxRailWidthForWindow(windowWidth),
  };
}

const splitRailStore = createSplitRailStore(Storage);

export const loadSplitRailWidths = () => splitRailStore.load();
export const saveSplitRailWidth = (page: SplitPageId, width: number) =>
  splitRailStore.save(page, width);
export const splitRailWidthFor = (page: SplitPageId) => splitRailStore.widthFor(page);
export const splitMaxRailWidth = () => splitRailStore.maxWidthForWindow();
