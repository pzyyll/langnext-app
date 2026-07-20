// ABOUTME: Helpers for per-workspace used-language tabs on the translate page.
// ABOUTME: Auto is pinned; concrete tabs grow only after the user actually uses them.

import { AUTO_LANGUAGE, isLanguageId, type LanguageId, type SelectableLanguageId } from "./-languages";

/** Max tabs per side including the pinned Auto tab. */
export const MAX_RECENT_LANGUAGES = 3;

/** Max concrete (non-auto) languages stored/shown after Auto. */
export const MAX_USED_LANGUAGES = MAX_RECENT_LANGUAGES - 1;

/**
 * Used concrete languages for one workspace side (never includes `auto`).
 * Persisted on the workspace document — not a global localStorage key.
 */
export type UsedLanguagesSide = LanguageId[];

/** Empty history: only Auto (+ current selection) until the user uses more languages. */
export const EMPTY_USED_LANGUAGES: LanguageId[] = [];

/** Source and target strips pin Auto as the first tab. */
export const AUTO_PIN_FIRST: SelectableLanguageId = AUTO_LANGUAGE;
/** @deprecated Use AUTO_PIN_FIRST. */
export const SOURCE_PIN_FIRST: SelectableLanguageId = AUTO_PIN_FIRST;

/** Normalize a stored used-language list (concrete ids only, capped). */
export function normalizeUsedLanguageIds(raw: unknown, max = MAX_USED_LANGUAGES): LanguageId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LanguageId[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // Accept legacy rows that stored `auto`; only concrete ids are kept.
    if (typeof item !== "string" || !isLanguageId(item) || seen.has(item)) {
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

export type VisibleTabsOptions = {
  max?: number;
  /** Always `auto` for both strips. */
  pinFirst?: SelectableLanguageId;
};

/**
 * Visible tab ids: pinned Auto + used concretes + current (if concrete and not yet used).
 * Does not reorder on selection; growth only happens via `recordLanguageUse`.
 */
export function visibleLanguageTabs(
  used: readonly SelectableLanguageId[],
  current: SelectableLanguageId,
  options: VisibleTabsOptions = {},
): SelectableLanguageId[] {
  const max = options.max ?? MAX_RECENT_LANGUAGES;
  const pinFirst = options.pinFirst ?? AUTO_PIN_FIRST;

  const concrete: LanguageId[] = [];
  const seen = new Set<string>();
  for (const id of used) {
    if (!isLanguageId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    concrete.push(id);
  }

  // Show the active concrete selection even before it has been persisted as "used".
  if (isLanguageId(current) && !seen.has(current)) {
    concrete.push(current);
  }

  // Cap concrete slots; always keep `current` when it is concrete.
  let capped = concrete.slice(0, Math.max(0, max - 1));
  if (isLanguageId(current) && !capped.includes(current)) {
    if (capped.length < max - 1) {
      capped = [...capped, current];
    } else if (capped.length > 0) {
      capped = [...capped.slice(0, -1), current];
    } else {
      capped = [current];
    }
  }

  return [pinFirst, ...capped].slice(0, max);
}

/**
 * Record a language the user actually selected.
 * - Keeps first-use order (no move-to-front).
 * - Persists the previous concrete selection so it stays on the strip after switching.
 * - Ignores `auto` as a stored entry (Auto is always pinned in the UI).
 */
export function recordLanguageUse(
  used: readonly SelectableLanguageId[],
  selected: SelectableLanguageId,
  previous: SelectableLanguageId,
  maxConcrete = MAX_USED_LANGUAGES,
): LanguageId[] {
  const next: LanguageId[] = [];
  const seen = new Set<string>();

  function pushConcrete(id: SelectableLanguageId) {
    if (!isLanguageId(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    next.push(id);
  }

  for (const id of used) {
    pushConcrete(id);
  }
  // Leaving a concrete tab should keep it visible (e.g. English stays when picking Chinese).
  if (previous !== selected) {
    pushConcrete(previous);
  }
  pushConcrete(selected);

  if (next.length <= maxConcrete) {
    return next;
  }
  // Drop oldest first-use entries when over capacity.
  return next.slice(next.length - maxConcrete);
}

/**
 * Admit a language from the more-picker / tab interaction (alias of record with same previous).
 * Prefer `recordLanguageUse` when previous selection is known.
 */
export function admitLanguageToTabs(
  used: readonly SelectableLanguageId[],
  id: SelectableLanguageId,
  options: VisibleTabsOptions & { previous?: SelectableLanguageId } = {},
): SelectableLanguageId[] {
  const previous = options.previous ?? id;
  const recorded = recordLanguageUse(used, id, previous, MAX_USED_LANGUAGES);
  // Return storage shape (concrete only); callers pass this back into visibleLanguageTabs.
  return recorded;
}

/**
 * When both sides would share the same concrete language, force the other side to Auto.
 * Returns the other side's next selection (unchanged when no conflict).
 */
export function resolveOppositeOnConflict(
  selected: SelectableLanguageId,
  opposite: SelectableLanguageId,
): SelectableLanguageId {
  if (selected !== AUTO_LANGUAGE && selected === opposite) {
    return AUTO_LANGUAGE;
  }
  return opposite;
}

/** @deprecated Use recordLanguageUse. */
export function touchRecentLanguage(
  recents: readonly SelectableLanguageId[],
  id: SelectableLanguageId,
  max = MAX_RECENT_LANGUAGES,
): SelectableLanguageId[] {
  const maxConcrete = Math.max(0, max - 1);
  return recordLanguageUse(recents, id, id, maxConcrete);
}

/** @deprecated Use visibleLanguageTabs. */
export function displayRecentLanguages(
  current: SelectableLanguageId,
  recents: readonly SelectableLanguageId[],
  max = MAX_RECENT_LANGUAGES,
): SelectableLanguageId[] {
  return visibleLanguageTabs(recents, current, { max, pinFirst: AUTO_PIN_FIRST });
}
