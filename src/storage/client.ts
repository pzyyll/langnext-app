// ABOUTME: Promise façade for Query-backed DTO CRUD over the Rust storage subsystem.
// ABOUTME: Translate orchestration and file workflows live under src/features/*; no SQL/fs/credential APIs exposed to React.
import type {
  AppSettingsDto,
  AppSettingsUpdate,
  IntegrationDependencyDto,
  IntegrationInstanceDto,
  IntegrationInstanceWrite,
  IntegrationValidationResult,
  ManualModelWrite,
  ModelConfigWrite,
  OcrRecognizeInput,
  OcrRecognizeResult,
  OcrServiceDto,
  OcrServiceWrite,
  SpeechServiceDto,
  SpeechServiceWrite,
  SpeechSynthesizeInput,
  ProviderInstanceDto,
  ProviderInstanceWrite,
  ProviderModelDto,
  RegionScreenshotBackdrop,
  RegionScreenshotResult,
  RegionScreenshotSelection,
  ServiceIntegrationManifest,
  ShortcutDefinition,
  TranslationHistoryDto,
  TranslationHistoryListQuery,
  TranslationHistoryListResult,
  TranslationHistoryModelFacet,
  TranslationProfileDto,
  TranslationProfileWrite,
} from "./types";
import { invokeEffect } from "./invokeEffect";
import { runStorage } from "./runStorage";

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

export async function listOcrServices(): Promise<OcrServiceDto[]> {
  return runStorage(invokeEffect<OcrServiceDto[]>("list_ocr_services"));
}

export async function getOcrService(id: string): Promise<OcrServiceDto> {
  return runStorage(invokeEffect<OcrServiceDto>("get_ocr_service", { id }));
}

export async function saveOcrService(input: OcrServiceWrite): Promise<OcrServiceDto> {
  return runStorage(invokeEffect<OcrServiceDto>("save_ocr_service", { input }));
}

export async function deleteOcrService(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_ocr_service", { id }));
}

export async function listSpeechServices(): Promise<SpeechServiceDto[]> {
  return runStorage(invokeEffect<SpeechServiceDto[]>("list_speech_services"));
}

export async function getSpeechService(id: string): Promise<SpeechServiceDto> {
  return runStorage(invokeEffect<SpeechServiceDto>("get_speech_service", { id }));
}

export async function saveSpeechService(input: SpeechServiceWrite): Promise<SpeechServiceDto> {
  return runStorage(invokeEffect<SpeechServiceDto>("save_speech_service", { input }));
}

export async function deleteSpeechService(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_speech_service", { id }));
}

/**
 * Synthesize speech to raw MP3 bytes via Tauri binary IPC.
 * Normalizes ArrayBuffer | Uint8Array responses to Uint8Array.
 */
export async function synthesizeSpeech(input: SpeechSynthesizeInput): Promise<Uint8Array> {
  const raw = await runStorage(invokeEffect<ArrayBuffer | Uint8Array>("synthesize_speech", { input }));
  if (raw instanceof Uint8Array) {
    return raw;
  }
  return new Uint8Array(raw);
}

/** Cancel an in-flight speech synthesis request by client request id. */
export async function cancelSpeechSynthesis(requestId: string): Promise<boolean> {
  return runStorage(invokeEffect<boolean>("cancel_speech_synthesis", { requestId }));
}

export async function listServiceIntegrationDefinitions(): Promise<ServiceIntegrationManifest[]> {
  return runStorage(invokeEffect<ServiceIntegrationManifest[]>("list_service_integration_definitions"));
}

export async function listIntegrationInstances(): Promise<IntegrationInstanceDto[]> {
  return runStorage(invokeEffect<IntegrationInstanceDto[]>("list_integration_instances"));
}

export async function getIntegrationInstance(id: string): Promise<IntegrationInstanceDto> {
  return runStorage(invokeEffect<IntegrationInstanceDto>("get_integration_instance", { id }));
}

export async function saveIntegrationInstance(input: IntegrationInstanceWrite): Promise<IntegrationInstanceDto> {
  return runStorage(invokeEffect<IntegrationInstanceDto>("save_integration_instance", { input }));
}

export async function setIntegrationInstanceEnabled(id: string, enabled: boolean): Promise<IntegrationInstanceDto> {
  return runStorage(invokeEffect<IntegrationInstanceDto>("set_integration_instance_enabled", { id, enabled }));
}

export async function listIntegrationInstanceDependencies(id: string): Promise<IntegrationDependencyDto[]> {
  return runStorage(invokeEffect<IntegrationDependencyDto[]>("list_integration_instance_dependencies", { id }));
}

export async function deleteIntegrationInstance(id: string): Promise<void> {
  return runStorage(invokeEffect<void>("delete_integration_instance", { id }));
}

/** Local-only validation (Phase 1A). Never claims remote/IAM health. */
export async function validateIntegrationInstance(id: string): Promise<IntegrationValidationResult> {
  return runStorage(invokeEffect<IntegrationValidationResult>("validate_integration_instance", { id }));
}

/**
 * Backend OCR recognition (`recognize_ocr`).
 * Dispatches Baidu native and plugin_capability (Vision); AI OCR stays on the frontend.
 */
export async function recognizeBaiduOcr(input: OcrRecognizeInput): Promise<OcrRecognizeResult> {
  return runStorage(invokeEffect<OcrRecognizeResult>("recognize_ocr", { input }));
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

/** Persist the OCR service used for region-screenshot text recognition. */
export async function setAppDefaultOcrService(defaultOcrServiceId: string | null): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("set_app_default_ocr_service", { defaultOcrServiceId }));
}

/** Persist the Speech service used for Translate playback. */
export async function setAppDefaultSpeechService(defaultSpeechServiceId: string | null): Promise<AppSettingsDto> {
  return runStorage(invokeEffect<AppSettingsDto>("set_app_default_speech_service", { defaultSpeechServiceId }));
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

/** Start the region-screenshot overlay (used by Quick Translate OCR). */
export async function startRegionScreenshot(): Promise<void> {
  return runStorage(invokeEffect<void>("start_region_screenshot"));
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
