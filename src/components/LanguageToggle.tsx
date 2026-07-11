// ABOUTME: Sidebar control that cycles the UI language between en and zh-CN.
// ABOUTME: Persists the choice through AppSettings.uiLanguage in Tauri.
import { useLanguage } from "../i18n/useLanguage";
import { languageDisplayName } from "../i18n/languages";

const buttonClassName =
	"inline-flex h-8 w-full items-center justify-start gap-2 rounded-none border-0 bg-transparent px-3 text-sm leading-none font-normal text-muted select-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

export function LanguageToggle() {
	const { language, toggle, error, t } = useLanguage();
	const currentLabel = language === "en" ? t("language.en") : t("language.zhCN");

	return (
		<div className="flex w-full flex-col gap-1">
			<button
				type="button"
				className={buttonClassName}
				aria-label={t("language.switchAria", { language: languageDisplayName(language) })}
				onClick={() => {
					void toggle();
				}}
			>
				<span className="pointer-events-none size-4 shrink-0 text-center text-[10px] leading-4 font-bold tracking-wide">
					{language === "en" ? "EN" : "中"}
				</span>
				<span>
					{t("language.label")}: {currentLabel}
				</span>
			</button>
			{error ? (
				<p className="px-3 text-xs text-danger" role="alert" aria-live="polite">
					{error}
				</p>
			) : null}
		</div>
	);
}
