// ABOUTME: Promise façade for Query-backed DTO CRUD over the Rust storage subsystem.
// ABOUTME: Translate orchestration and file workflows live under src/features/*; no SQL/fs/credential APIs exposed to React.
import type {
  AppSettingsDto,
  AppSettingsUpdate,
  ConnectionTestResult,
  ManualModelWrite,
  ModelConfigWrite,
  ProviderInstanceDto,
  ProviderInstanceWrite,
  ProviderModelDto,
  RegionScreenshotBackdrop,
  RegionScreenshotResult,
  RegionScreenshotSelection,
  ShortcutDefinition,
  SyncModelsResult,
  TranslateInput,
  TranslateResult,
  TranslationHistoryDto,
  TranslationHistoryListQuery,
  TranslationHistoryListResult,
  TranslationHistoryModelFacet,
  TranslationProfileDto,
  TranslationProfileWrite,
} from "./types";
import { invokeEffect } from "./invokeEffect";
import { runStorage } from "./runStorage";

/**
 * Storage client ownership:
 * - Query/DTO CRUD (list/save/history/settings/screenshot/etc.) lives here.
 * - Stream/detect/cancel orchestration: `src/features/translate/*` (`runStartTranslateStream`, `runDetectLanguage`, `runCancelRequestIds`).
 * - Configuration file transfer: `src/features/settings/configurationTransfer.ts`.
 *
 * Event names emitted by `translate_text_stream` (listeners still attach from routes).
 */
export const TRANSLATE_CHUNK_EVENT = "translate://chunk";
export const TRANSLATE_RESET_EVENT = "translate://reset";
export const TRANSLATE_DONE_EVENT = "translate://done";
export const TRANSLATE_ERROR_EVENT = "translate://error";

export async function listProviderInstances(): Promise<ProviderInstanceDto[]> {
  return runStorage(invokeEffect<ProviderInstanceDto[]>("list_provider_instances"));
}

export async function saveProviderInstance(input: ProviderInstanceWrite): Promise<ProviderInstanceDto> {
  return runStorage(invokeEffect<ProviderInstanceDto>("save_provider_instance", { input }));
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<ProviderInstanceDto> {
  return runStorage(invokeEffect<ProviderInstanceDto>("set_provider_enabled", { id, enabled }));
}

export async function deleteProviderInstance(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_provider_instance", { id }));
}

export async function reorderProviderInstances(ids: string[]): Promise<void> {
  return runStorage(invokeEffect<void>("reorder_provider_instances", { ids }));
}

export async function listProviderModels(providerInstanceId: string): Promise<ProviderModelDto[]> {
  return runStorage(invokeEffect<ProviderModelDto[]>("list_provider_models", { providerInstanceId }));
}

export async function listAllProviderModels(): Promise<ProviderModelDto[]> {
  return runStorage(invokeEffect<ProviderModelDto[]>("list_all_provider_models"));
}

/**
 * Non-streaming translate. Pass `requestId` so batch cancel (`runCancelRequestIds`)
 * can abort mid-flight via the shared cancel registry.
 */
export async function translateText(input: TranslateInput, requestId?: string): Promise<TranslateResult> {
  return runStorage(invokeEffect<TranslateResult>("translate_text", { input, requestId: requestId ?? null }));
}

export async function saveManualModel(input: ManualModelWrite): Promise<ProviderModelDto> {
  return runStorage(invokeEffect<ProviderModelDto>("save_manual_model", { input }));
}

export async function setModelEnabled(id: string, enabled: boolean): Promise<ProviderModelDto> {
  return runStorage(invokeEffect<ProviderModelDto>("set_model_enabled", { id, enabled }));
}

/** Set optional per-model API Type; pass null to inherit the channel adapter. */
export async function setModelAdapterId(id: string, adapterId: string | null): Promise<ProviderModelDto> {
  return runStorage(invokeEffect<ProviderModelDto>("set_model_adapter_id", { id, adapterId }));
}

/** Update per-model display name, API Type, and capability overrides for any model source. */
export async function updateModelConfig(input: ModelConfigWrite): Promise<ProviderModelDto> {
  return runStorage(invokeEffect<ProviderModelDto>("update_model_config", { input }));
}

export async function deleteProviderModel(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_provider_model", { id }));
}

/** Bulk-delete models in one backend transaction (all-or-nothing). */
export async function deleteProviderModels(ids: string[]): Promise<void> {
  return runStorage(invokeEffect<void>("delete_provider_models", { ids }));
}

export async function testProviderConnection(providerInstanceId: string): Promise<ConnectionTestResult> {
  return runStorage(invokeEffect<ConnectionTestResult>("test_provider_connection", { providerInstanceId }));
}

export async function syncProviderModels(providerInstanceId: string): Promise<SyncModelsResult> {
  return runStorage(invokeEffect<SyncModelsResult>("sync_provider_models", { providerInstanceId }));
}

/** Profile list rows include ordered target chains for list summaries (no N+1 detail fetch). */
export async function listTranslationProfiles(): Promise<TranslationProfileDto[]> {
  return runStorage(invokeEffect<TranslationProfileDto[]>("list_translation_profiles"));
}

export async function getTranslationProfile(id: string): Promise<TranslationProfileDto> {
  return runStorage(invokeEffect<TranslationProfileDto>("get_translation_profile", { id }));
}

export async function saveTranslationProfile(input: TranslationProfileWrite): Promise<TranslationProfileDto> {
  return runStorage(invokeEffect<TranslationProfileDto>("save_translation_profile", { input }));
}

export async function setTranslationProfileEnabled(id: string, enabled: boolean): Promise<TranslationProfileDto> {
  return runStorage(invokeEffect<TranslationProfileDto>("set_translation_profile_enabled", { id, enabled }));
}

export async function deleteTranslationProfile(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_translation_profile", { id }));
}

export async function getAppSettings(): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("get_app_settings"));
}

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("update_app_settings", { input }));
}

export async function setAppTheme(theme: "light" | "dark" | null): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("set_app_theme", { theme }));
}

export async function setAppUiLanguage(uiLanguage: string): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("set_app_ui_language", { uiLanguage }));
}

export async function setAppShortcuts(shortcuts: ShortcutDefinition[]): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("set_app_shortcuts", { shortcuts }));
}

/** Full-monitor PNG backdrop path for the active region-screenshot overlay. */
export async function regionScreenshotGetBackdrop(): Promise<RegionScreenshotBackdrop> {
  return runStorage(invokeEffect<RegionScreenshotBackdrop>("region_screenshot_get_backdrop"));
}

/** Fallback backdrop PNG as base64 when asset-protocol loading fails. */
export async function regionScreenshotGetBackdropData(): Promise<string> {
  return runStorage(invokeEffect<string>("region_screenshot_get_backdrop_data"));
}

/** Re-focus / re-show the overlay after the backdrop image has painted. */
export async function regionScreenshotReveal(): Promise<void> {
  return runStorage(invokeEffect<void>("region_screenshot_reveal"));
}

/** Crop the pre-captured monitor image with the overlay selection. */
export async function regionScreenshotConfirm(selection: RegionScreenshotSelection): Promise<RegionScreenshotResult> {
  return runStorage(invokeEffect<RegionScreenshotResult>("region_screenshot_confirm", { selection }));
}

/** Cancel the active region screenshot without producing an image. */
export async function regionScreenshotCancel(): Promise<void> {
  return runStorage(invokeEffect<void>("region_screenshot_cancel"));
}

export async function listTranslationHistory(
  query: TranslationHistoryListQuery,
): Promise<TranslationHistoryListResult> {
  return runStorage(invokeEffect<TranslationHistoryListResult>("list_translation_history", { query }));
}

export async function getTranslationHistory(id: string): Promise<TranslationHistoryDto> {
  return runStorage(invokeEffect<TranslationHistoryDto>("get_translation_history", { id }));
}

export async function getTranslationHistoryMany(ids: string[]): Promise<TranslationHistoryDto[]> {
  return runStorage(invokeEffect<TranslationHistoryDto[]>("get_translation_history_many", { ids }));
}

export async function listTranslationHistoryModelFacets(): Promise<TranslationHistoryModelFacet[]> {
  return runStorage(invokeEffect<TranslationHistoryModelFacet[]>("list_translation_history_model_facets"));
}

export async function deleteTranslationHistory(ids: string[]): Promise<void> {
  return runStorage(invokeEffect<void>("delete_translation_history", { ids }));
}

export async function deleteAllTranslationHistory(): Promise<void> {
  return runStorage(invokeEffect<void>("delete_all_translation_history"));
}
