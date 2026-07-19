// ABOUTME: Frontend-safe DTO and command-input types for the storage subsystem.
// ABOUTME: Never includes credentialRef, secrets, SQL, or filesystem paths.
export type CredentialKind = "none" | "api_key" | "bearer";
export type ProxyMode = "inherit" | "direct";
export type ModelsSyncStatus = "never" | "ok" | "error";
export type ModelSource = "remote" | "manual" | "builtin";
export type Availability = "available" | "missing" | "unknown";
export type GlobalProxyMode = "system" | "custom";
export type ImportConflictMode = "merge" | "copy";
/** Bounded codes persisted on ProviderInstanceDto.modelsSyncErrorCode. */
export type ModelsSyncErrorCode =
  "auth" | "rate_limited" | "network" | "timeout" | "server" | "invalid_response" | "credential_unavailable";

/**
 * Codes returned by sync_provider_models IPC.
 * Includes non-persisted race outcomes such as connection_changed (never stored on the provider row).
 */
export type SyncModelsResultCode = ModelsSyncErrorCode | "connection_changed";

export type CredentialUpdate = { action: "keep" } | { action: "replace"; value: string } | { action: "clear" };

export type ProxyCredentialUpdate = { action: "keep" } | { action: "replace"; value: string } | { action: "clear" };

export interface ProviderInstanceDto {
  id: string;
  adapterId: string;
  displayName: string;
  baseUrlOverride: string | null;
  credentialKind: CredentialKind;
  hasCredential: boolean;
  enabled: boolean;
  proxyMode: ProxyMode;
  insecureHttpConfirmedAt: string | null;
  modelsSyncedAt: string | null;
  modelsSyncStatus: ModelsSyncStatus;
  modelsSyncErrorCode: ModelsSyncErrorCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Transport / credential failure only; never connection_changed. */
  errorCode: ModelsSyncErrorCode | null;
  message: string;
  modelCount: number | null;
  /**
   * Non-sensitive connection version from the provider row at resolve time
   * (`provider.updatedAt`). UI should only display results that still match
   * the currently selected provider's `updatedAt`.
   */
  providerUpdatedAt: string;
}

export interface SyncModelsResult {
  ok: boolean;
  /**
   * Failure or race outcome for this request.
   * connection_changed is not a ModelsSyncErrorCode and is never persisted on the provider.
   */
  errorCode: SyncModelsResultCode | null;
  message: string;
  models: ProviderModelDto[];
  provider: ProviderInstanceDto;
}

export interface ProviderInstanceWrite {
  id?: string | null;
  adapterId: string;
  displayName: string;
  baseUrlOverride?: string | null;
  credentialKind: CredentialKind;
  credential: CredentialUpdate;
  enabled: boolean;
  proxyMode: ProxyMode;
  insecureHttpConfirmedAt?: string | null;
  /**
   * Optimistic concurrency baseline (`ProviderInstanceDto.updatedAt` when the form was loaded).
   * Required on update (`id` set); ignored on create.
   */
  expectedUpdatedAt?: string | null;
}

/** Versioned sparse capability overrides accepted on manual writes and import. */
export interface CapabilityOverridesV1 {
  schemaVersion: 1;
  streaming?: boolean | null;
  /** Model context-window limit. Defaults to 128 Ki tokens in the editor. */
  maxContextTokens?: number | null;
  /** Max tokens for the model; used for requests when a profile does not override. */
  maxOutputTokens?: number | null;
  /** Request max tokens when a profile does not override; kept equal to maxOutputTokens by the editor. */
  defaultOutputTokens?: number | null;
  textGeneration?: boolean | null;
  imageAnalysis?: boolean | null;
  videoProcessing?: boolean | null;
}

export interface ProviderModelDto {
  id: string;
  providerInstanceId: string;
  modelKey: string;
  source: ModelSource;
  remoteDisplayName: string | null;
  displayNameOverride: string | null;
  enabled: boolean;
  availability: Availability;
  remoteMetadataJson: unknown | null;
  capabilityOverridesJson: CapabilityOverridesV1 | null;
  /** Optional API Type override; null inherits the channel adapter at runtime. */
  adapterId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManualModelWrite {
  id?: string | null;
  providerInstanceId: string;
  modelKey: string;
  displayNameOverride?: string | null;
  enabled: boolean;
  capabilityOverridesJson?: CapabilityOverridesV1 | null;
  /** Optional API Type override; null/empty inherits the channel adapter. */
  adapterId?: string | null;
}

/** Input for updating per-model display name, API Type, and capability overrides (any source). */
export interface ModelConfigWrite {
  id: string;
  /** Optional display-name override; null/empty clears to remote name or model key. */
  displayNameOverride?: string | null;
  /** Optional API Type override; null/empty inherits the channel adapter. */
  adapterId?: string | null;
  /** Versioned sparse capability overrides; null clears overrides. */
  capabilityOverridesJson?: CapabilityOverridesV1 | null;
}

/** Input for one-shot or streaming translate via a configured provider model. */
export interface TranslateInput {
  modelId: string;
  sourceLang: string;
  targetLang: string;
  text: string;
  /** Optional profile for templates + fallback model chain. */
  profileId?: string | null;
  /** Optional prompt-template override for this request; must belong to profileId when set. */
  promptTemplateId?: string | null;
  /** Configured source language id (`auto` allowed). History metadata only. */
  sourceLangId?: string | null;
  /** Configured target language id (`auto` allowed). History metadata only. */
  targetLangId?: string | null;
  /** Concrete source language id actually used (post-detection). History metadata only. */
  effectiveSourceLangId?: string | null;
  /** Concrete target language id actually used (post Auto resolution). History metadata only. */
  effectiveTargetLangId?: string | null;
}

/** Result of translate_text IPC (success or soft provider/validation failure). */
export interface TranslateResult {
  translatedText: string;
  latencyMs: number;
  errorCode?: string | null;
  message: string;
  ok: boolean;
  /** Model that produced the result when a fallback chain was used. */
  modelId?: string | null;
}

/** Progressive chunk from translate_text_stream (`translate://chunk`). */
export interface TranslateStreamChunk {
  id: string;
  delta: string;
}

/** Fallback chain switched models — clear progressive output (`translate://reset`). */
export interface TranslateStreamReset {
  id: string;
  /** Model that will produce subsequent chunks. */
  modelId: string;
}

/** Terminal success/soft-failure from translate_text_stream (`translate://done`). */
export interface TranslateStreamDone {
  id: string;
  translatedText: string;
  latencyMs: number;
  ok: boolean;
  message: string;
  errorCode?: string | null;
  modelId?: string | null;
}

/** Hard failure from translate_text_stream (`translate://error`). */
export interface TranslateStreamError {
  id: string;
  errorCode: string;
  message: string;
  latencyMs: number;
}

/** Detector backend that produced a DetectLanguageResult. Mirrors the Rust tagged enum. */
export type DetectorType = "llm";

/** Tagged language detector config. `type` selects the backend; only `llm` exists today. */
export type LanguageDetectorConfig = { type: "llm"; modelId?: string | null };

/** Input for detect_language IPC. */
export interface DetectLanguageInput {
  text: string;
  /** Default LLM model used when no profile is selected / no explicit config. */
  modelId?: string | null;
  /** Profile supplying detector config and the primary model fallback. */
  profileId?: string | null;
}

/** Result of detect_language IPC (success or soft provider/validation failure). */
export interface DetectLanguageResult {
  ok: boolean;
  /** Detected supported language id (e.g. `zh`); null on soft failure. */
  languageId?: string | null;
  /** Detector backend that produced this result. */
  detectorType: DetectorType;
  /** Model used for detection (LLM variant); null when no model was reached. */
  modelId?: string | null;
  latencyMs: number;
  /** Bounded failure code when `ok` is false. */
  errorCode?: string | null;
  message: string;
}

/** One named prompt template belonging to a translation profile. */
export interface PromptTemplate {
  id: string;
  name: string;
  systemTemplate: string;
  userTemplate: string;
}

/** Persistence/export row for a prompt template (includes profile ownership + list order). */
export interface TranslationProfilePromptTemplate extends PromptTemplate {
  translationProfileId: string;
  sortOrder: number;
}

export interface TranslationProfile {
  id: string;
  name: string;
  enabled: boolean;
  templateVersion: number;
  /** Id of the template used when translate does not pass an override. */
  defaultPromptTemplateId: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  providerOptionsJson: unknown | null;
  sourceLang?: string | null;
  targetLang?: string | null;
  /** Profile Primary preference (concrete supported id); null on legacy profiles. */
  primaryLang?: string | null;
  /** Profile Target preference (concrete supported id); null on legacy profiles. */
  preferredTargetLang?: string | null;
  /** Optional language detector config; null/absent uses the default LLM detector. */
  languageDetection?: LanguageDetectorConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationProfileTarget {
  translationProfileId: string;
  providerModelId: string;
  priority: number;
}

export interface TranslationProfileDto extends TranslationProfile {
  targets: TranslationProfileTarget[];
  /** Ordered prompt templates for this profile. */
  promptTemplates: PromptTemplate[];
}

export interface TranslationProfileWrite {
  id?: string | null;
  name: string;
  enabled: boolean;
  templateVersion: number;
  /** Must reference one entry in promptTemplates. */
  defaultPromptTemplateId: string;
  /** Complete ordered template list for this profile (at least one). */
  promptTemplates: PromptTemplate[];
  temperature?: number | null;
  maxOutputTokens?: number | null;
  providerOptionsJson?: unknown | null;
  sourceLang?: string | null;
  targetLang?: string | null;
  /** Profile Primary preference (concrete supported id); omitted on legacy writes. */
  primaryLang?: string | null;
  /** Profile Target preference (concrete supported id); omitted on legacy writes. */
  preferredTargetLang?: string | null;
  /** Optional language detector config; null/absent clears to the default LLM detector. */
  languageDetection?: LanguageDetectorConfig | null;
  targetModelIds: string[];
}

export interface NetworkSettings {
  proxyMode: GlobalProxyMode;
  proxyUrl: string | null;
}

export interface TranslationPreferences {
  autoDetectSource: boolean;
  preserveFormatting: boolean;
}

export interface ShortcutDefinition {
  id: string;
  binding: string;
}

export interface AppSettingsV1 {
  schemaVersion: number;
  uiLanguage: string;
  theme: "light" | "dark" | null;
  defaultProfileId: string | null;
  translation: TranslationPreferences;
  shortcuts: ShortcutDefinition[];
  network: NetworkSettings;
}

export interface AppSettingsDto extends AppSettingsV1 {
  proxyHasCredential: boolean;
}

export interface AppSettingsUpdate {
  settings: AppSettingsV1;
  proxyCredential: ProxyCredentialUpdate;
}

export interface ProviderExport {
  id: string;
  adapterId: string;
  displayName: string;
  baseUrlOverride: string | null;
  credentialKind: CredentialKind;
  enabled: boolean;
  proxyMode: ProxyMode;
  insecureHttpConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigurationExport {
  formatVersion: number;
  exportedAt: string;
  providers: ProviderExport[];
  models: ProviderModelDto[];
  translationProfiles: TranslationProfile[];
  profileModels: TranslationProfileTarget[];
  /** Ordered prompt templates for all profiles. */
  profilePromptTemplates: TranslationProfilePromptTemplate[];
  appSettings: AppSettingsV1;
}

export interface ImportPreviewCounts {
  providersCreate: number;
  providersUpdate: number;
  providersCopy: number;
  modelsCreate: number;
  modelsUpdate: number;
  modelsCopy: number;
  profilesCreate: number;
  profilesUpdate: number;
  profilesCopy: number;
}

export interface ImportPreview {
  valid: boolean;
  counts: ImportPreviewCounts;
  validationErrors: string[];
  requiresAuthentication: string[];
  proxyRequiresAuthentication: boolean;
  defaultProfileCleared: boolean;
}

export interface ImportResult {
  preview: ImportPreview;
  applied: boolean;
}

export interface IpcError {
  code: string;
  message: string;
}

/** Persisted outcome of a completed translate attempt. */
export type HistoryStatus = "complete" | "failed";

/** Full history row for get / get_many / CSV export. */
export interface TranslationHistoryDto {
  id: string;
  createdAt: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  effectiveSourceLang: string | null;
  effectiveTargetLang: string | null;
  modelId: string | null;
  modelDisplayName: string;
  providerDisplayName: string | null;
  profileId: string | null;
  profileName: string | null;
  status: HistoryStatus;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
}

/** List row: previews instead of full text. */
export interface TranslationHistoryListItemDto {
  id: string;
  createdAt: string;
  sourceTextPreview: string;
  translatedTextPreview: string;
  sourceTextTruncated: boolean;
  translatedTextTruncated: boolean;
  sourceLang: string;
  targetLang: string;
  effectiveSourceLang: string | null;
  effectiveTargetLang: string | null;
  modelId: string | null;
  modelDisplayName: string;
  providerDisplayName: string | null;
  profileId: string | null;
  profileName: string | null;
  status: HistoryStatus;
  errorCode: string | null;
  latencyMs: number;
}

export interface TranslationHistoryListQuery {
  search?: string | null;
  modelId?: string | null;
  /** Effective source OR target language id filter. */
  language?: string | null;
  /** Local YYYY-MM-DD day; the service expands it to UTC bounds using offsetMinutes. */
  date?: string | null;
  /** Client UTC offset in minutes (positive east of UTC). */
  offsetMinutes?: number | null;
  page: number;
  pageSize?: number | null;
}

export interface TranslationHistoryListResult {
  items: TranslationHistoryListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TranslationHistoryModelFacet {
  modelId: string | null;
  modelDisplayName: string;
  lastSeenAt: string;
}

/** Compile-time fixtures ensuring DTO shapes stay aligned with Rust serde. */
const _providerDtoFixture = {
  id: "00000000-0000-7000-8000-000000000001",
  adapterId: "openai-compatible",
  displayName: "Local",
  baseUrlOverride: null,
  credentialKind: "api_key",
  hasCredential: true,
  enabled: true,
  proxyMode: "inherit",
  insecureHttpConfirmedAt: null,
  modelsSyncedAt: null,
  modelsSyncStatus: "never",
  modelsSyncErrorCode: null,
  createdAt: "2026-07-10T00:00:00Z",
  updatedAt: "2026-07-10T00:00:00Z",
} as const satisfies ProviderInstanceDto;

const _settingsUpdateFixture = {
  settings: {
    schemaVersion: 1,
    uiLanguage: "en",
    theme: "dark",
    defaultProfileId: null,
    translation: { autoDetectSource: true, preserveFormatting: true },
    shortcuts: [],
    network: { proxyMode: "system", proxyUrl: null },
  },
  proxyCredential: { action: "keep" },
} as const satisfies AppSettingsUpdate;

const _capabilityFixture = {
  schemaVersion: 1,
  streaming: true,
  maxContextTokens: 8192,
  maxOutputTokens: 2048,
  defaultOutputTokens: 1024,
  textGeneration: true,
  imageAnalysis: false,
  videoProcessing: false,
} as const satisfies CapabilityOverridesV1;

const _modelConfigWriteFixture = {
  id: "00000000-0000-7000-8000-000000000002",
  adapterId: "openai-compatible",
  capabilityOverridesJson: _capabilityFixture,
} as const satisfies ModelConfigWrite;

const _modelDtoFixture = {
  id: "00000000-0000-7000-8000-000000000002",
  providerInstanceId: "00000000-0000-7000-8000-000000000001",
  modelKey: "gpt-4o",
  source: "manual",
  remoteDisplayName: null,
  displayNameOverride: "GPT-4o",
  enabled: true,
  availability: "available",
  remoteMetadataJson: null,
  capabilityOverridesJson: _capabilityFixture,
  adapterId: null,
  lastSeenAt: null,
  createdAt: "2026-07-10T00:00:00Z",
  updatedAt: "2026-07-10T00:00:00Z",
} as const satisfies ProviderModelDto;

const _profileWriteFixture = {
  name: "Default",
  enabled: true,
  templateVersion: 1,
  defaultPromptTemplateId: "00000000-0000-7000-8000-0000000000aa",
  promptTemplates: [
    {
      id: "00000000-0000-7000-8000-0000000000aa",
      name: "Default",
      systemTemplate: "Translate carefully.",
      userTemplate: "{{text}}",
    },
  ],
  temperature: 0.2,
  maxOutputTokens: 1024,
  providerOptionsJson: {},
  primaryLang: "zh",
  preferredTargetLang: "en",
  targetModelIds: ["00000000-0000-7000-8000-000000000002"],
} as const satisfies TranslationProfileWrite;

const _importPreviewFixture = {
  valid: true,
  counts: {
    providersCreate: 1,
    providersUpdate: 0,
    providersCopy: 0,
    modelsCreate: 1,
    modelsUpdate: 0,
    modelsCopy: 0,
    profilesCreate: 1,
    profilesUpdate: 0,
    profilesCopy: 0,
  },
  validationErrors: [],
  requiresAuthentication: ["00000000-0000-7000-8000-000000000001"],
  proxyRequiresAuthentication: false,
  defaultProfileCleared: false,
} as const satisfies ImportPreview;

const _importResultFixture = {
  preview: _importPreviewFixture,
  applied: true,
} as const satisfies ImportResult;

const _ipcErrorFixture = {
  code: "validation_failed",
  message: "display_name must not be empty",
} as const satisfies IpcError;

const _detectLanguageResultFixture = {
  ok: true,
  languageId: "zh",
  detectorType: "llm",
  modelId: "00000000-0000-7000-8000-000000000002",
  latencyMs: 42,
  message: "ok",
} as const satisfies DetectLanguageResult;

const _connectionTestFixture = {
  ok: true,
  errorCode: null,
  message: "Connection succeeded; 2 models available",
  modelCount: 2,
  providerUpdatedAt: "2026-07-10T00:00:00Z",
} as const satisfies ConnectionTestResult;

const _syncModelsFixture = {
  ok: false,
  errorCode: "network",
  message: "Network request failed",
  models: [_modelDtoFixture],
  provider: _providerDtoFixture,
} as const satisfies SyncModelsResult;

const _syncModelsConnectionChangedFixture = {
  ok: false,
  errorCode: "connection_changed",
  message: "Connection settings changed during sync; models were not updated. Sync again.",
  models: [_modelDtoFixture],
  provider: _providerDtoFixture,
} as const satisfies SyncModelsResult;

void _providerDtoFixture;
void _settingsUpdateFixture;
void _capabilityFixture;
void _modelConfigWriteFixture;
void _modelDtoFixture;
void _profileWriteFixture;
void _importPreviewFixture;
void _importResultFixture;
void _ipcErrorFixture;
void _connectionTestFixture;
void _syncModelsFixture;
void _syncModelsConnectionChangedFixture;
void _detectLanguageResultFixture;
