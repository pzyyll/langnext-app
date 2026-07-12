// ABOUTME: Typed invoke wrappers for the Rust storage subsystem.
// ABOUTME: No SQL, filesystem, or credential APIs are exposed to React.
import { invoke } from "@tauri-apps/api/core";
import type {
	AppSettingsDto,
	AppSettingsUpdate,
	ConfigurationExport,
	ConnectionTestResult,
	ImportConflictMode,
	ImportPreview,
	ImportResult,
	ManualModelWrite,
	ModelConfigWrite,
	ProviderInstanceDto,
	ProviderInstanceWrite,
	ProviderModelDto,
	SyncModelsResult,
	TranslateInput,
	TranslateResult,
	TranslationProfileDto,
	TranslationProfileWrite,
} from "./types";

/** Event names emitted by translate_text_stream. */
export const TRANSLATE_CHUNK_EVENT = "translate://chunk";
export const TRANSLATE_RESET_EVENT = "translate://reset";
export const TRANSLATE_DONE_EVENT = "translate://done";
export const TRANSLATE_ERROR_EVENT = "translate://error";

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

export async function reorderProviderInstances(ids: string[]): Promise<void> {
	return invoke("reorder_provider_instances", { ids });
}

export async function listProviderModels(providerInstanceId: string): Promise<ProviderModelDto[]> {
	return invoke("list_provider_models", { providerInstanceId });
}

export async function listAllProviderModels(): Promise<ProviderModelDto[]> {
	return invoke("list_all_provider_models");
}

/**
 * Non-streaming translate. Pass `requestId` so `cancelTranslate` can abort mid-flight.
 */
export async function translateText(input: TranslateInput, requestId?: string): Promise<TranslateResult> {
	return invoke("translate_text", { input, requestId: requestId ?? null });
}

/**
 * Start a streaming translation. `requestId` must be registered with event listeners
 * before this invoke so early validation failures cannot race past the active-id assignment.
 */
export async function translateTextStream(input: TranslateInput, requestId: string): Promise<void> {
	return invoke("translate_text_stream", { input, requestId });
}

/** Abort an in-flight translate (stream or non-stream) by client `requestId`. */
export async function cancelTranslate(requestId: string): Promise<boolean> {
	return invoke("cancel_translate", { requestId });
}

export async function saveManualModel(input: ManualModelWrite): Promise<ProviderModelDto> {
	return invoke("save_manual_model", { input });
}

export async function setModelEnabled(id: string, enabled: boolean): Promise<ProviderModelDto> {
	return invoke("set_model_enabled", { id, enabled });
}

/** Set optional per-model API Type; pass null to inherit the channel adapter. */
export async function setModelAdapterId(id: string, adapterId: string | null): Promise<ProviderModelDto> {
	return invoke("set_model_adapter_id", { id, adapterId });
}

/** Update per-model API Type and capability overrides for any model source. */
export async function updateModelConfig(input: ModelConfigWrite): Promise<ProviderModelDto> {
	return invoke("update_model_config", { input });
}

export async function deleteProviderModel(id: string): Promise<void> {
	return invoke("delete_provider_model", { id });
}

/** Bulk-delete models in one backend transaction (all-or-nothing). */
export async function deleteProviderModels(ids: string[]): Promise<void> {
	return invoke("delete_provider_models", { ids });
}

export async function testProviderConnection(providerInstanceId: string): Promise<ConnectionTestResult> {
	return invoke("test_provider_connection", { providerInstanceId });
}

export async function syncProviderModels(providerInstanceId: string): Promise<SyncModelsResult> {
	return invoke("sync_provider_models", { providerInstanceId });
}

/** Profile list rows include ordered target chains for list summaries (no N+1 detail fetch). */
export async function listTranslationProfiles(): Promise<TranslationProfileDto[]> {
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

export async function setAppUiLanguage(uiLanguage: string): Promise<AppSettingsDto> {
	return invoke("set_app_ui_language", { uiLanguage });
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
