import type { SourceLanguageId, TargetLanguageId } from "./languages";

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
  templates: PromptTemplate[];
  defaultTemplateId: string;
}

/** Discriminated preset engine union for future non-AI engines. */
export type PresetEngine = AiPresetEngine;

export interface TranslationPreset {
  id: string;
  name: string;
  enabled: boolean;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId | null;
  createdAt: string;
  updatedAt: string;
  engine: PresetEngine;
}

export interface SaveAiPresetEngineInput {
  kind: "ai";
  modelIds: readonly string[];
  temperature: number | string | null;
  maxOutputTokens: number | string | null;
  templates: readonly PromptTemplate[];
  defaultTemplateId: string;
}

export interface SavePresetInput {
  id?: string | null;
  name: string;
  enabled: boolean;
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId | null;
  engine: SaveAiPresetEngineInput;
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
  | "source_language_invalid"
  | "target_language_invalid"
  | "engine_unsupported"
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
  | "sourceLanguage"
  | "targetLanguage"
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
  | { kind: "ready" }
  | { kind: "error"; key: PresetErrorKey; message: string };

export interface PresetsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PresetsStore {
  load(): Promise<void>;
  records(): TranslationPreset[];
  status(): PresetsStoreStatus;
  mutating(): boolean;
  save(input: SavePresetInput): Promise<TranslationPreset>;
  remove(id: string): Promise<void>;
}
