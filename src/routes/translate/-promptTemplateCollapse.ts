// ABOUTME: Profile editor UI prefs for prompt-template card collapse state.
// ABOUTME: Persists collapsed template ids to localStorage with safe parse fallbacks.

/** Namespaced key for collapsed prompt-template card ids in the profile editor. */
export const PROMPT_TEMPLATE_COLLAPSE_KEY = "langnext-translate-profile-prompt-template-collapse";

/**
 * Normalize a raw stored value into unique non-empty template id strings.
 * Accepts a bare string array or `{ collapsedTemplateIds: string[] }`.
 */
export function normalizeCollapsedTemplateIds(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw != null && typeof raw === "object" && "collapsedTemplateIds" in raw
      ? (raw as { collapsedTemplateIds: unknown }).collapsedTemplateIds
      : null;

  if (!Array.isArray(list)) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string" || item === "" || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Read collapsed template ids; invalid JSON or values fall back to expanded (empty). */
export function getCollapsedPromptTemplateIds(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = localStorage.getItem(PROMPT_TEMPLATE_COLLAPSE_KEY);
    if (stored == null || stored === "") {
      return [];
    }
    return normalizeCollapsedTemplateIds(JSON.parse(stored) as unknown);
  } catch {
    return [];
  }
}

/** Persist collapsed template ids (browser + Tauri webview localStorage). Swallows storage errors. */
export function setCollapsedPromptTemplateIds(ids: Iterable<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    localStorage.setItem(PROMPT_TEMPLATE_COLLAPSE_KEY, JSON.stringify(normalizeCollapsedTemplateIds([...ids])));
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}
