// ABOUTME: Button that toggles light/dark theme via semantic theme tokens.
// ABOUTME: Uses unplugin-icons for sun/moon glyphs; no-drag safe for titlebar use.
import IconClaritySunLine from "~icons/clarity/sun-line";
import IconClarityMoonLine from "~icons/clarity/moon-line";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/useTheme";

const buttonClassName =
	"inline-flex h-8 w-full items-center justify-start gap-2 rounded-none border-0 bg-transparent px-3 text-sm leading-none font-normal text-muted select-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

export function ThemeToggle() {
	const { isDark, toggle, error } = useTheme();
	const { t } = useTranslation();

	return (
		<div className="flex w-full flex-col gap-1">
			<button
				type="button"
				className={buttonClassName}
				aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
				onClick={() => {
					void toggle();
				}}
			>
				{isDark ? (
					<IconClaritySunLine className="pointer-events-none size-4 shrink-0" />
				) : (
					<IconClarityMoonLine className="pointer-events-none size-4 shrink-0" />
				)}
				<span>{isDark ? t("theme.light") : t("theme.dark")}</span>
			</button>
			{error ? (
				<p className="px-3 text-xs text-danger" role="alert" aria-live="polite">
					{error}
				</p>
			) : null}
		</div>
	);
}
