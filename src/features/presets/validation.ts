import { t } from "nsh/i18n";
import { normalizeDeepLXEndpoint } from "../../modules/deeplx/endpoint";
import { isTemperature, isTemperatureText } from "./temperature";
import {
  PresetsStoreError,
  type AiPresetEngine,
  type PromptTemplate,
  type SavePresetInput,
  type TranslationPreset,
} from "./types";

const ALLOWED_TEMPLATE_VARS = new Set(["source_language", "target_language", "text"]);
const INTEGER_PATTERN = /^\d+$/;

function parseOptionalTemperature(raw: number | string | null): number | null {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return null;
  if (typeof raw === "number" ? isTemperature(raw) : isTemperatureText(raw)) {
    return Number(raw);
  }
  throw new PresetsStoreError("temperature_invalid", t("presets.error.temperatureInvalid"), {
    field: "temperature",
  });
}

function parseOptionalMaxOutputTokens(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new PresetsStoreError(
        "max_output_tokens_invalid",
        t("presets.error.maxOutputTokensInvalid"),
        { field: "maxOutputTokens" },
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new PresetsStoreError(
      "max_output_tokens_invalid",
      t("presets.error.maxOutputTokensInvalid"),
      { field: "maxOutputTokens" },
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PresetsStoreError(
      "max_output_tokens_invalid",
      t("presets.error.maxOutputTokensInvalid"),
      { field: "maxOutputTokens" },
    );
  }
  return parsed;
}

function validatePromptBody(
  body: string,
  field: "systemTemplate" | "userTemplate",
  templateId: string,
): void {
  let textCount = 0;
  let rest = body;
  while (true) {
    const start = rest.indexOf("{{");
    if (start === -1) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end === -1) {
      throw new PresetsStoreError(
        "template_unclosed_variable",
        t("presets.error.templateUnclosedVariable"),
        { field, templateId },
      );
    }
    const variableName = after.slice(0, end).trim();
    if (!ALLOWED_TEMPLATE_VARS.has(variableName)) {
      throw new PresetsStoreError(
        "template_unknown_variable",
        t("presets.error.templateUnknownVariable", { name: variableName }),
        { field, templateId },
      );
    }
    if (variableName === "text") {
      textCount += 1;
    }
    rest = after.slice(end + 2);
  }

  if (field === "userTemplate") {
    if (textCount === 0) {
      throw new PresetsStoreError(
        "user_template_text_required",
        t("presets.error.userTemplateTextRequired"),
        { field, templateId },
      );
    }
    if (textCount > 1) {
      throw new PresetsStoreError(
        "user_template_text_duplicate",
        t("presets.error.userTemplateTextDuplicate"),
        { field, templateId },
      );
    }
  }
}

/** A validated engine plus the plaintext key the store persists outside the preset record. */
export type ValidatedPresetEngine =
  | { kind: "ai"; engine: AiPresetEngine }
  | { kind: "deepl"; apiKey: string | null }
  | { kind: "deeplx"; endpointUrl: string; token: string | null | undefined }
  | { kind: "google-cloud"; apiKey: string | null }
  | { kind: "google-web" };

export interface ValidatedPresetPayload {
  name: string;
  enabled: boolean;
  engine: ValidatedPresetEngine;
}

/** Reads a DeepLX token for save: undefined keeps a stored token, null clears it, a string replaces it. */
function parseDeepLXToken(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const invalid = () =>
    new PresetsStoreError("deeplx_token_invalid", t("presets.error.deeplxTokenInvalid"), {
      field: "deeplxToken",
    });
  if (typeof raw !== "string") throw invalid();
  const token = raw.trim();
  // An empty string means an interrupted edit, not a request to clear the token; null does that.
  if (token.length === 0 || !/^[\x21-\x7E]+$/.test(token)) throw invalid();
  return token;
}

/** Reads an optional credential key for save: blank keeps the stored key, embedded whitespace is invalid. */
function parseCredentialApiKey(raw: unknown, field: "deeplKey" | "googleCloudKey"): string | null {
  const invalidKey = field === "deeplKey" ? "deepl_key_invalid" : "google_cloud_key_invalid";
  const invalidMessage =
    field === "deeplKey"
      ? t("presets.error.deeplKeyInvalid")
      : t("presets.error.googleCloudKeyInvalid");
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new PresetsStoreError(invalidKey, invalidMessage, { field });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) {
    throw new PresetsStoreError(invalidKey, invalidMessage, { field });
  }
  return trimmed;
}

/** Validates a preset save payload against engine, model-availability, numeric, and template rules. */
export function validatePresetForSave(
  input: SavePresetInput,
  availableModelIds: ReadonlySet<string>,
  existing: TranslationPreset | null,
): ValidatedPresetPayload {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    throw new PresetsStoreError("name_required", t("presets.error.nameRequired"), {
      field: "name",
    });
  }

  if (
    !input.engine ||
    (input.engine.kind !== "ai" &&
      input.engine.kind !== "deepl" &&
      input.engine.kind !== "deeplx" &&
      input.engine.kind !== "google-cloud" &&
      input.engine.kind !== "google-web")
  ) {
    throw new PresetsStoreError("engine_unsupported", t("presets.error.engineUnsupported"));
  }

  if (existing !== null && input.engine.kind !== existing.engine.kind) {
    throw new PresetsStoreError("engine_type_locked", t("presets.error.engineTypeLocked"));
  }

  if (input.engine.kind === "deepl") {
    const apiKey = parseCredentialApiKey(input.engine.apiKey, "deeplKey");
    const hasStoredKey =
      existing !== null &&
      existing.engine.kind === "deepl" &&
      existing.engine.credentialRef.length > 0;
    if (!hasStoredKey && apiKey === null) {
      throw new PresetsStoreError("deepl_key_required", t("presets.error.deeplKeyRequired"), {
        field: "deeplKey",
      });
    }
    return {
      name,
      enabled: Boolean(input.enabled),
      engine: { kind: "deepl", apiKey },
    };
  }

  if (input.engine.kind === "deeplx") {
    const endpointUrl = normalizeDeepLXEndpoint(input.engine.endpointUrl);
    if (endpointUrl === null) {
      throw new PresetsStoreError(
        "deeplx_endpoint_invalid",
        t("presets.error.deeplxEndpointInvalid"),
        { field: "deeplxEndpoint" },
      );
    }
    return {
      name,
      enabled: Boolean(input.enabled),
      engine: {
        kind: "deeplx",
        endpointUrl,
        token: parseDeepLXToken(input.engine.token),
      },
    };
  }

  if (input.engine.kind === "google-cloud") {
    const apiKey = parseCredentialApiKey(input.engine.apiKey, "googleCloudKey");
    const hasStoredKey =
      existing !== null &&
      existing.engine.kind === "google-cloud" &&
      existing.engine.credentialRef.length > 0;
    if (!hasStoredKey && apiKey === null) {
      throw new PresetsStoreError(
        "google_cloud_key_required",
        t("presets.error.googleCloudKeyRequired"),
        { field: "googleCloudKey" },
      );
    }
    return {
      name,
      enabled: Boolean(input.enabled),
      engine: { kind: "google-cloud", apiKey },
    };
  }

  if (input.engine.kind === "google-web") {
    return {
      name,
      enabled: Boolean(input.enabled),
      engine: { kind: "google-web" },
    };
  }

  const rawModelIds = input.engine.modelIds;
  if (!Array.isArray(rawModelIds) || rawModelIds.length === 0) {
    throw new PresetsStoreError("primary_model_required", t("presets.error.primaryModelRequired"), {
      field: "primaryModel",
    });
  }

  const existingAi = existing !== null && existing.engine.kind === "ai" ? existing.engine : null;
  const existingPrimaryId = existingAi?.modelIds[0] ?? null;
  const existingFallbackIds = new Set(existingAi?.modelIds.slice(1) ?? []);

  const primaryId = rawModelIds[0];
  if (typeof primaryId !== "string" || primaryId.trim().length === 0) {
    throw new PresetsStoreError("primary_model_required", t("presets.error.primaryModelRequired"), {
      field: "primaryModel",
    });
  }
  const canKeepExistingPrimary = existing !== null && primaryId === existingPrimaryId;
  if (!canKeepExistingPrimary && !availableModelIds.has(primaryId)) {
    throw new PresetsStoreError("model_unavailable", t("presets.error.modelUnavailable"), {
      field: "primaryModel",
    });
  }

  const seenModelIds = new Set<string>([primaryId]);
  const modelIds: string[] = [primaryId];

  for (let index = 1; index < rawModelIds.length; index++) {
    const fallbackIndex = index - 1;
    const fallbackId = rawModelIds[index];
    if (typeof fallbackId !== "string" || fallbackId.trim().length === 0) {
      throw new PresetsStoreError("model_unavailable", t("presets.error.modelUnavailable"), {
        field: "fallbackModel",
        fallbackIndex,
      });
    }
    if (seenModelIds.has(fallbackId)) {
      throw new PresetsStoreError("model_duplicate", t("presets.error.modelDuplicate"), {
        field: "fallbackModel",
        fallbackIndex,
      });
    }
    const canKeepExistingFallback = existing !== null && existingFallbackIds.has(fallbackId);
    if (!canKeepExistingFallback && !availableModelIds.has(fallbackId)) {
      throw new PresetsStoreError("model_unavailable", t("presets.error.modelUnavailable"), {
        field: "fallbackModel",
        fallbackIndex,
      });
    }
    seenModelIds.add(fallbackId);
    modelIds.push(fallbackId);
  }

  const temperature = parseOptionalTemperature(input.engine.temperature);
  const maxOutputTokens = parseOptionalMaxOutputTokens(input.engine.maxOutputTokens);

  const rawTemplates = input.engine.templates;
  if (!Array.isArray(rawTemplates) || rawTemplates.length === 0) {
    throw new PresetsStoreError("templates_required", t("presets.error.templatesRequired"), {
      field: "templates",
    });
  }

  const seenTemplateIds = new Set<string>();
  const templates: PromptTemplate[] = [];

  for (const tpl of rawTemplates) {
    if (!tpl || typeof tpl.id !== "string" || tpl.id.trim().length === 0) {
      throw new PresetsStoreError("template_id_invalid", t("presets.error.templateIdInvalid"), {
        field: "templates",
      });
    }
    if (seenTemplateIds.has(tpl.id)) {
      throw new PresetsStoreError("template_id_duplicate", t("presets.error.templateIdDuplicate"), {
        field: "templates",
        templateId: tpl.id,
      });
    }
    seenTemplateIds.add(tpl.id);

    const templateName = typeof tpl.name === "string" ? tpl.name.trim() : "";
    if (!templateName) {
      throw new PresetsStoreError(
        "template_name_required",
        t("presets.error.templateNameRequired"),
        { field: "templateName", templateId: tpl.id },
      );
    }

    if (typeof tpl.systemTemplate !== "string") {
      throw new PresetsStoreError(
        "template_unclosed_variable",
        t("presets.error.templateUnclosedVariable"),
        { field: "systemTemplate", templateId: tpl.id },
      );
    }
    validatePromptBody(tpl.systemTemplate, "systemTemplate", tpl.id);

    if (typeof tpl.userTemplate !== "string") {
      throw new PresetsStoreError(
        "user_template_text_required",
        t("presets.error.userTemplateTextRequired"),
        { field: "userTemplate", templateId: tpl.id },
      );
    }
    validatePromptBody(tpl.userTemplate, "userTemplate", tpl.id);

    templates.push({
      id: tpl.id,
      name: templateName,
      systemTemplate: tpl.systemTemplate,
      userTemplate: tpl.userTemplate,
    });
  }

  const defaultTemplateId = input.engine.defaultTemplateId;
  if (typeof defaultTemplateId !== "string" || !seenTemplateIds.has(defaultTemplateId)) {
    throw new PresetsStoreError(
      "default_template_invalid",
      t("presets.error.defaultTemplateInvalid"),
      { field: "defaultTemplate" },
    );
  }

  return {
    name,
    enabled: Boolean(input.enabled),
    engine: {
      kind: "ai",
      engine: {
        kind: "ai",
        modelIds,
        temperature,
        maxOutputTokens,
        // Turning thinking off is the default; only an explicit false keeps it on.
        disableReasoning: input.engine.disableReasoning !== false,
        templates,
        defaultTemplateId,
      },
    },
  };
}
