// ABOUTME: UI preferences for the provider models list toolbar.
// ABOUTME: Persists enabled-status filter to localStorage with safe fallbacks.

export type ModelEnabledFilter = "all" | "enabled" | "disabled";

/** Namespaced key for the models enabled-status filter preference. */
export const MODEL_ENABLED_FILTER_KEY = "langnext-models-enabled-filter";

export function isModelEnabledFilter(value: string | null | undefined): value is ModelEnabledFilter {
	return value === "all" || value === "enabled" || value === "disabled";
}

/** Read the persisted enabled filter; invalid or missing values fall back to `all`. */
export function getModelEnabledFilter(): ModelEnabledFilter {
	if (typeof window === "undefined") {
		return "all";
	}

	const stored = localStorage.getItem(MODEL_ENABLED_FILTER_KEY);
	return isModelEnabledFilter(stored) ? stored : "all";
}

/** Persist the enabled filter preference (browser + Tauri webview localStorage). */
export function setModelEnabledFilter(filter: ModelEnabledFilter): void {
	if (typeof window === "undefined") {
		return;
	}
	localStorage.setItem(MODEL_ENABLED_FILTER_KEY, filter);
}

/**
 * Case-insensitive partial match against the user-visible model key and internal id.
 * Empty / whitespace-only queries match everything.
 */
export function modelMatchesSearch(model: { id: string; modelKey: string }, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	return model.modelKey.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle);
}
