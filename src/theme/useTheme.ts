// ABOUTME: React hook that tracks the active light/dark theme mode.
// ABOUTME: Persists theme through settings IPC in Tauri and rolls back on failure.
import { useCallback, useEffect, useState } from "react";
import i18n from "../i18n";
import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY, applyThemeToDom, getAppliedTheme, type ThemeMode } from "./theme";
import { setAppTheme } from "../storage/client";
import { ThemeMutationQueue } from "./themeMutationQueue";

function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useTheme() {
	const [theme, setThemeState] = useState<ThemeMode>(() => getAppliedTheme());
	const [error, setError] = useState<string | null>(null);

	// Mutable box for last successful theme; not a React ref to avoid render-time ref lint.
	const [baselineBox] = useState(() => ({ value: getAppliedTheme() as ThemeMode }));

	const [queue] = useState(() => {
		const q = new ThemeMutationQueue({
			persist: async (mode) => {
				if (!isTauriRuntime()) {
					return;
				}
				await setAppTheme(mode);
			},
			onSuccess: (mode, mutationId) => {
				if (mutationId === q.latestMutationId) {
					setError(null);
					baselineBox.value = mode;
				}
			},
			onFailure: (_mode, mutationId, err) => {
				// Rollback only when the failed mutation is still the latest visible action.
				if (mutationId === q.latestMutationId) {
					const rollback = baselineBox.value;
					applyThemeToDom(rollback);
					setThemeState(rollback);
					setError(err instanceof Error ? err.message : i18n.t("theme.persistFailed"));
				}
			},
		});
		return q;
	});

	useEffect(() => {
		const sync = () => {
			setThemeState(getAppliedTheme());
		};

		const onStorage = (event: StorageEvent) => {
			if (event.key === THEME_STORAGE_KEY || event.key === null) {
				sync();
			}
		};

		window.addEventListener(THEME_CHANGE_EVENT, sync);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(THEME_CHANGE_EVENT, sync);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const setTheme = useCallback(
		async (mode: ThemeMode) => {
			// Optimistic DOM/cache update; baseline stays until a success for the latest id.
			applyThemeToDom(mode);
			setThemeState(mode);
			setError(null);
			queue.enqueue(mode);
		},
		[queue],
	);

	const toggle = useCallback(async () => {
		const next: ThemeMode = getAppliedTheme() === "dark" ? "light" : "dark";
		await setTheme(next);
		return next;
	}, [setTheme]);

	return { theme, setTheme, toggle, isDark: theme === "dark", error };
}
