// ABOUTME: Persist recent translate language tabs (source/target) in localStorage.
// ABOUTME: Fixed tab order like Google Translate; only new picks reshuffle slots.

import { AUTO_LANGUAGE, isSelectableLanguageId, type SelectableLanguageId } from "./-languages";

/** Namespaced key for recent language chips on the translate page. */
export const RECENT_LANGUAGES_KEY = "langnext-translate-recent-languages";

/** Max language tabs shown per side (Google-style rail, excluding the more caret). */
export const MAX_RECENT_LANGUAGES = 3;

export type RecentLanguagesStore = {
  source: SelectableLanguageId[];
  target: SelectableLanguageId[];
};

/** Default tab seeds when storage is empty or invalid. */
export const DEFAULT_RECENT_SOURCE_LANGUAGES: SelectableLanguageId[] = ["auto", "en", "zh"];
export const DEFAULT_RECENT_TARGET_LANGUAGES: SelectableLanguageId[] = ["en", "zh", "ja"];

function normalizeRecentList(raw: unknown, max = MAX_RECENT_LANGUAGES): SelectableLanguageId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SelectableLanguageId[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !isSelectableLanguageId(item) || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/** Normalize a raw document into capped source/target tab lists. */
export function normalizeRecentLanguagesStore(raw: unknown): RecentLanguagesStore {
  if (raw == null || typeof raw !== "object") {
    return {
      source: [...DEFAULT_RECENT_SOURCE_LANGUAGES],
      target: [...DEFAULT_RECENT_TARGET_LANGUAGES],
    };
  }
  const record = raw as Record<string, unknown>;
  const source = normalizeRecentList(record.source);
  const target = normalizeRecentList(record.target);
  return {
    source: source.length > 0 ? source : [...DEFAULT_RECENT_SOURCE_LANGUAGES],
    target: target.length > 0 ? target : [...DEFAULT_RECENT_TARGET_LANGUAGES],
  };
}

/** Read recent language tabs; invalid JSON falls back to defaults. */
export function getRecentLanguagesStore(): RecentLanguagesStore {
  if (typeof window === "undefined") {
    return {
      source: [...DEFAULT_RECENT_SOURCE_LANGUAGES],
      target: [...DEFAULT_RECENT_TARGET_LANGUAGES],
    };
  }
  try {
    const stored = localStorage.getItem(RECENT_LANGUAGES_KEY);
    if (stored == null || stored === "") {
      return {
        source: [...DEFAULT_RECENT_SOURCE_LANGUAGES],
        target: [...DEFAULT_RECENT_TARGET_LANGUAGES],
      };
    }
    return normalizeRecentLanguagesStore(JSON.parse(stored) as unknown);
  } catch {
    return {
      source: [...DEFAULT_RECENT_SOURCE_LANGUAGES],
      target: [...DEFAULT_RECENT_TARGET_LANGUAGES],
    };
  }
}

/** Persist recent language tabs. Swallows quota / private-mode errors. */
export function setRecentLanguagesStore(store: RecentLanguagesStore): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = normalizeRecentLanguagesStore(store);
    localStorage.setItem(RECENT_LANGUAGES_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures.
  }
}

export type VisibleTabsOptions = {
  max?: number;
  /** When set (e.g. `auto` on source), this id stays in slot 0. */
  pinFirst?: SelectableLanguageId;
};

/**
 * Visible tab ids in **stable order** (Google Translate tablist behavior).
 * Selecting an existing tab must not reorder; only inject `current` when missing.
 */
export function visibleLanguageTabs(
  tabs: readonly SelectableLanguageId[],
  current: SelectableLanguageId,
  options: VisibleTabsOptions = {},
): SelectableLanguageId[] {
  const max = options.max ?? MAX_RECENT_LANGUAGES;
  const pinFirst = options.pinFirst;
  let list = tabs.filter((id, index, all) => all.indexOf(id) === index);

  if (pinFirst) {
    list = [pinFirst, ...list.filter((id) => id !== pinFirst)];
  }

  if (!list.includes(current)) {
    if (list.length < max) {
      list = [...list, current];
    } else {
      // Replace the last non-pinned slot so pinFirst and other tabs keep position.
      let replaceAt = list.length - 1;
      if (pinFirst && list[replaceAt] === pinFirst) {
        replaceAt = Math.max(0, list.length - 2);
      }
      if (replaceAt >= 0) {
        list = list.slice();
        list[replaceAt] = current;
      }
    }
  }

  if (pinFirst) {
    list = [pinFirst, ...list.filter((id) => id !== pinFirst)];
  }

  return list.slice(0, max);
}

/**
 * Admit a language chosen from the full picker into the tab strip.
 * - Already present: keep order (tab select only).
 * - New: insert after pin (or at front), drop overflow from the end.
 */
export function admitLanguageToTabs(
  tabs: readonly SelectableLanguageId[],
  id: SelectableLanguageId,
  options: VisibleTabsOptions = {},
): SelectableLanguageId[] {
  const max = options.max ?? MAX_RECENT_LANGUAGES;
  const pinFirst = options.pinFirst;

  if (tabs.includes(id)) {
    return visibleLanguageTabs(tabs, id, options);
  }

  if (pinFirst) {
    if (id === pinFirst) {
      return visibleLanguageTabs(tabs, id, options);
    }
    const rest = tabs.filter((item) => item !== pinFirst && item !== id);
    return [pinFirst, id, ...rest].slice(0, max);
  }

  const rest = tabs.filter((item) => item !== id);
  return [id, ...rest].slice(0, max);
}

/** @deprecated Use admitLanguageToTabs / visibleLanguageTabs — kept name for older imports. */
export function touchRecentLanguage(
  recents: readonly SelectableLanguageId[],
  id: SelectableLanguageId,
  max = MAX_RECENT_LANGUAGES,
): SelectableLanguageId[] {
  return admitLanguageToTabs(recents, id, { max });
}

/** @deprecated Use visibleLanguageTabs. */
export function displayRecentLanguages(
  current: SelectableLanguageId,
  recents: readonly SelectableLanguageId[],
  max = MAX_RECENT_LANGUAGES,
): SelectableLanguageId[] {
  return visibleLanguageTabs(recents, current, { max });
}

/** Source strip always pins Auto-detect as the first tab (Google). */
export const SOURCE_PIN_FIRST: SelectableLanguageId = AUTO_LANGUAGE;
