// ABOUTME: Frontend-safe DTO and command-input types for the storage subsystem.
// ABOUTME: Never includes credentialRef, secrets, SQL, or filesystem paths.
export type CredentialKind = "none" | "api_key" | "bearer";
export type ProxyMode = "inherit" | "direct";
export type ModelsSyncStatus = "never" | "ok" | "error";
export type ModelSource = "remote" | "manual" | "builtin";
export type Availability = "available" | "missing" | "unknown";
export type GlobalProxyMode = "system" | "custom";
export type ImportConflictMode = "merge" | "copy";

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
	modelsSyncErrorCode: string | null;
	createdAt: string;
	updatedAt: string;
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
}

/** Versioned sparse capability overrides accepted on manual writes and import. */
export interface CapabilityOverridesV1 {
	schemaVersion: 1;
	streaming?: boolean | null;
	maxContextTokens?: number | null;
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
}

export interface TranslationProfile {
	id: string;
	name: string;
	enabled: boolean;
	templateVersion: number;
	systemTemplate: string;
	userTemplate: string;
	temperature: number | null;
	maxOutputTokens: number | null;
	providerOptionsJson: unknown | null;
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
}

export interface TranslationProfileWrite {
	id?: string | null;
	name: string;
	enabled: boolean;
	templateVersion: number;
	systemTemplate: string;
	userTemplate: string;
	temperature?: number | null;
	maxOutputTokens?: number | null;
	providerOptionsJson?: unknown | null;
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
} as const satisfies CapabilityOverridesV1;

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
	lastSeenAt: null,
	createdAt: "2026-07-10T00:00:00Z",
	updatedAt: "2026-07-10T00:00:00Z",
} as const satisfies ProviderModelDto;

const _profileWriteFixture = {
	name: "Default",
	enabled: true,
	templateVersion: 1,
	systemTemplate: "Translate carefully.",
	userTemplate: "{{text}}",
	temperature: 0.2,
	maxOutputTokens: 1024,
	providerOptionsJson: {},
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

void _providerDtoFixture;
void _settingsUpdateFixture;
void _capabilityFixture;
void _modelDtoFixture;
void _profileWriteFixture;
void _importPreviewFixture;
void _importResultFixture;
void _ipcErrorFixture;
