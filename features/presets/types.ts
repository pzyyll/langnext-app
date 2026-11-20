export interface PromptTemplate {
  id: string;
  name: string;
  systemTemplate: string;
  userTemplate: string;
}

export interface AiPresetEngine {
  kind: "ai";
  modelIds: string[];
  temperature: number | null;
  maxOutputTokens: number | null;
  /** Asks the models to skip reasoning, so translation starts and finishes sooner. */
  disableReasoning: boolean;
  templates: PromptTemplate[];
  defaultTemplateId: string;
}

/** DeepL engine: stores only a storage reference; the API key never lives in preset JSON. */
export interface DeepLPresetEngine {
  kind: "deepl";
  credentialRef: string;
}

/** Discriminated preset engine union; presets store engine configuration only. */
export type PresetEngine = AiPresetEngine | DeepLPresetEngine;

export interface TranslationPreset {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  engine: PresetEngine;
}

export interface SaveAiPresetEngineInput {
  kind: "ai";
  modelIds: readonly string[];
  temperature: number | string | null;
  maxOutputTokens: number | string | null;
  disableReasoning: boolean;
  templates: readonly PromptTemplate[];
  defaultTemplateId: string;
}

export interface SaveDeepLPresetEngineInput {
  kind: "deepl";
  /** New or replacement key; a blank value on an edit keeps the stored key. */
  apiKey?: string | null;
}

export type SavePresetEngineInput = SaveAiPresetEngineInput | SaveDeepLPresetEngineInput;

export interface SavePresetInput {
  id?: string | null;
  name: string;
  enabled: boolean;
  engine: SavePresetEngineInput;
}

export interface ModelChoice {
  id: string;
  channelId: string;
  modelKey: string;
  label: string;
}

/** Minimal model identifier snapshot read by the Presets Store. */
export interface ModelChoiceId {
  id: string;
}

export type PresetErrorKey =
  | "storage_read_failed"
  | "storage_malformed"
  | "storage_unsupported_version"
  | "storage_unreadable"
  | "storage_write_failed"
  | "mutation_in_progress"
  | "not_found"
  | "name_required"
  | "engine_unsupported"
  | "engine_type_locked"
  | "deepl_key_required"
  | "deepl_key_invalid"
  | "primary_model_required"
  | "model_unavailable"
  | "model_duplicate"
  | "temperature_invalid"
  | "max_output_tokens_invalid"
  | "templates_required"
  | "template_id_invalid"
  | "template_id_duplicate"
  | "template_name_required"
  | "template_unclosed_variable"
  | "template_unknown_variable"
  | "user_template_text_required"
  | "user_template_text_duplicate"
  | "default_template_invalid";

export type PresetValidationField =
  | "name"
  | "deeplKey"
  | "primaryModel"
  | "fallbackModel"
  | "temperature"
  | "maxOutputTokens"
  | "templates"
  | "templateName"
  | "systemTemplate"
  | "userTemplate"
  | "defaultTemplate";

export interface PresetsStoreErrorDetails {
  field?: PresetValidationField;
  templateId?: string;
  fallbackIndex?: number;
  cause?: unknown;
}

/** Typed error surfaced by Presets Store validation and storage operations. */
export class PresetsStoreError extends Error {
  readonly key: PresetErrorKey;
  readonly field?: PresetValidationField;
  readonly templateId?: string;
  readonly fallbackIndex?: number;

  constructor(key: PresetErrorKey, message: string, details: PresetsStoreErrorDetails = {}) {
    super(message);
    this.name = "PresetsStoreError";
    this.key = key;
    this.field = details.field;
    this.templateId = details.templateId;
    this.fallbackIndex = details.fallbackIndex;
    if (details.cause !== undefined) {
      (this as { cause?: unknown }).cause = details.cause;
    }
  }
}

export type PresetsStoreStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; skippedCount: number }
  | { kind: "error"; key: PresetErrorKey; message: string };

export interface PresetsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PresetsStore {
  load(): Promise<void>;
  records(): TranslationPreset[];
  status(): PresetsStoreStatus;
  mutating(): boolean;
  save(input: SavePresetInput): Promise<TranslationPreset>;
  remove(id: string): Promise<void>;
  /** Reads a DeepL preset's stored key; returns null for other engines or a missing key. */
  readDeepLCredential(presetId: string): Promise<string | null>;
}
