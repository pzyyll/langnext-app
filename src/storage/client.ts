// ABOUTME: Typed invoke wrappers for the Rust storage subsystem.
// ABOUTME: No SQL, filesystem, or credential APIs are exposed to React.
import { invoke } from "@tauri-apps/api/core";
import type {
	AppSettingsDto,
	AppSettingsUpdate,
	ConfigurationExport,
	ImportConflictMode,
	ImportPreview,
	ImportResult,
	ManualModelWrite,
	ProviderInstanceDto,
	ProviderInstanceWrite,
	ProviderModelDto,
	TranslationProfile,
	TranslationProfileDto,
	TranslationProfileWrite,
} from "./types";

export async function listProviderInstances(): Promise<ProviderInstanceDto[]> {
	return invoke("list_provider_instances");
}

export async function saveProviderInstance(input: ProviderInstanceWrite): Promise<ProviderInstanceDto> {
	return invoke("save_provider_instance", { input });
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<ProviderInstanceDto> {
	return invoke("set_provider_enabled", { id, enabled });
}

export async function deleteProviderInstance(id: string): Promise<void> {
	return invoke("delete_provider_instance", { id });
}

export async function listProviderModels(providerInstanceId: string): Promise<ProviderModelDto[]> {
	return invoke("list_provider_models", { providerInstanceId });
}

export async function saveManualModel(input: ManualModelWrite): Promise<ProviderModelDto> {
	return invoke("save_manual_model", { input });
}

export async function setModelEnabled(id: string, enabled: boolean): Promise<ProviderModelDto> {
	return invoke("set_model_enabled", { id, enabled });
}

export async function deleteProviderModel(id: string): Promise<void> {
	return invoke("delete_provider_model", { id });
}

export async function listTranslationProfiles(): Promise<TranslationProfile[]> {
	return invoke("list_translation_profiles");
}

export async function getTranslationProfile(id: string): Promise<TranslationProfileDto> {
	return invoke("get_translation_profile", { id });
}

export async function saveTranslationProfile(input: TranslationProfileWrite): Promise<TranslationProfileDto> {
	return invoke("save_translation_profile", { input });
}

export async function setTranslationProfileEnabled(id: string, enabled: boolean): Promise<TranslationProfileDto> {
	return invoke("set_translation_profile_enabled", { id, enabled });
}

export async function deleteTranslationProfile(id: string): Promise<void> {
	return invoke("delete_translation_profile", { id });
}

export async function getAppSettings(): Promise<AppSettingsDto> {
	return invoke("get_app_settings");
}

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AppSettingsDto> {
	return invoke("update_app_settings", { input });
}

export async function setAppTheme(theme: "light" | "dark" | null): Promise<AppSettingsDto> {
	return invoke("set_app_theme", { theme });
}

export async function exportConfiguration(): Promise<ConfigurationExport> {
	return invoke("export_configuration");
}

export async function previewConfigurationImport(
	document: ConfigurationExport,
	mode: ImportConflictMode,
): Promise<ImportPreview> {
	return invoke("preview_configuration_import", { document, mode });
}

export async function importConfiguration(
	document: ConfigurationExport,
	mode: ImportConflictMode,
): Promise<ImportResult> {
	return invoke("import_configuration", { document, mode });
}
