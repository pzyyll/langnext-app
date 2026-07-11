// ABOUTME: Settings route for appearance and language preferences.
// ABOUTME: Reuses useTheme/useLanguage hooks and their persistence paths.
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import IconClarityMoonLine from "~icons/clarity/moon-line";
import IconClaritySunLine from "~icons/clarity/sun-line";
import { APP_LANGUAGES, type AppLanguage } from "../i18n/languages";
import { useLanguage } from "../i18n/useLanguage";
import { useTheme } from "../theme/useTheme";
import type { ThemeMode } from "../theme/theme";

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
});

const optionBaseClassName =
	"flex min-h-10 flex-1 items-center gap-2 rounded-none border border-line bg-surface px-3 text-sm leading-none font-normal text-muted transition-colors duration-150 select-none hover:bg-surface-2 hover:text-ink focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ink";

const optionActiveClassName =
	"flex min-h-10 flex-1 items-center gap-2 rounded-none border border-line bg-surface-2 px-3 text-sm leading-none font-normal text-ink transition-colors duration-150 select-none focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ink";

const radioClassName =
	"size-4 shrink-0 rounded-none border border-line bg-surface text-ink accent-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink";

function SettingsPage() {
	const { t } = useTranslation();
	const { theme, setTheme, error: themeError } = useTheme();
	const { language, setLanguage, error: languageError } = useLanguage();

	const themeOptions: { value: ThemeMode; label: string; icon: "sun" | "moon" }[] = [
		{ value: "light", label: t("theme.light"), icon: "sun" },
		{ value: "dark", label: t("theme.dark"), icon: "moon" },
	];

	const languageOptions: { value: AppLanguage; label: string }[] = APP_LANGUAGES.map((value) => ({
		value,
		label: value === "en" ? t("language.en") : t("language.zhCN"),
	}));

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h1 className="text-2xl leading-8 font-bold text-ink">{t("settings.title")}</h1>
				<p className="max-w-2xl text-sm leading-6 text-muted">{t("settings.description")}</p>
			</section>

			<section className="shadow-frame max-w-lg border border-line bg-surface p-4">
				<fieldset className="flex flex-col gap-3 border-0 p-0">
					<legend className="float-left w-full text-sm leading-5 font-bold text-ink">
						{t("settings.theme.title")}
					</legend>
					<p id="settings-theme-desc" className="clear-both text-sm leading-5 text-muted">
						{t("settings.theme.description")}
					</p>
					<div className="flex flex-col gap-2 sm:flex-row" role="presentation">
						{themeOptions.map((option) => {
							const selected = theme === option.value;
							return (
								<label key={option.value} className={selected ? optionActiveClassName : optionBaseClassName}>
									<input
										type="radio"
										name="settings-theme"
										value={option.value}
										checked={selected}
										className={radioClassName}
										aria-describedby="settings-theme-desc"
										onChange={() => {
											void setTheme(option.value);
										}}
									/>
									{option.icon === "sun" ? (
										<IconClaritySunLine className="pointer-events-none size-4 shrink-0" aria-hidden />
									) : (
										<IconClarityMoonLine className="pointer-events-none size-4 shrink-0" aria-hidden />
									)}
									<span>{option.label}</span>
								</label>
							);
						})}
					</div>
					{themeError ? (
						<p className="text-xs text-danger" role="alert" aria-live="polite">
							{themeError}
						</p>
					) : null}
				</fieldset>
			</section>

			<section className="shadow-frame max-w-lg border border-line bg-surface p-4">
				<fieldset className="flex flex-col gap-3 border-0 p-0">
					<legend className="float-left w-full text-sm leading-5 font-bold text-ink">
						{t("settings.language.title")}
					</legend>
					<p id="settings-language-desc" className="clear-both text-sm leading-5 text-muted">
						{t("settings.language.description")}
					</p>
					<div className="flex flex-col gap-2 sm:flex-row" role="presentation">
						{languageOptions.map((option) => {
							const selected = language === option.value;
							return (
								<label key={option.value} className={selected ? optionActiveClassName : optionBaseClassName}>
									<input
										type="radio"
										name="settings-language"
										value={option.value}
										checked={selected}
										className={radioClassName}
										aria-describedby="settings-language-desc"
										onChange={() => {
											void setLanguage(option.value);
										}}
									/>
									<span className="pointer-events-none size-4 shrink-0 text-center text-[10px] leading-4 font-bold tracking-wide">
										{option.value === "en" ? "EN" : "中"}
									</span>
									<span>{option.label}</span>
								</label>
							);
						})}
					</div>
					{languageError ? (
						<p className="text-xs text-danger" role="alert" aria-live="polite">
							{languageError}
						</p>
					) : null}
				</fieldset>
			</section>
		</div>
	);
}
