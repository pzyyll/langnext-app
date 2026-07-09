// ABOUTME: React hook that tracks the active light/dark theme mode.
// ABOUTME: Syncs with setTheme/toggleTheme and cross-tab storage events.
import { useCallback, useEffect, useState } from "react";
import {
	THEME_CHANGE_EVENT,
	THEME_STORAGE_KEY,
	getAppliedTheme,
	setTheme as applyThemeMode,
	toggleTheme as flipTheme,
	type ThemeMode,
} from "./theme";

export function useTheme() {
	const [theme, setThemeState] = useState<ThemeMode>(() => getAppliedTheme());

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

	const setTheme = useCallback((mode: ThemeMode) => {
		applyThemeMode(mode);
		setThemeState(mode);
	}, []);

	const toggle = useCallback(() => {
		const next = flipTheme();
		setThemeState(next);
		return next;
	}, []);

	return { theme, setTheme, toggle, isDark: theme === "dark" };
}
