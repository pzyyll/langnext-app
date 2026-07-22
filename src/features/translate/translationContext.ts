// ABOUTME: Resolve translation execution context from Query-backed DTOs.
// ABOUTME: Builds ordered fallback chain, prompts, and plugin/auth compatibility checks.
import type {
  AuthSchemeV1,
  ProviderInstanceDto,
  ProviderModelDto,
  TranslateInput,
  TranslationProfileDto,
} from "../../storage/types";
import { isModelApiTypeExecutable, requireProviderPlugin } from "../providers/registry";
import { PluginUnavailableError } from "../providers/registry";
import { buildDefaultTranslateSystemPrompt, renderPromptTemplate } from "./promptTemplate";

const DEFAULT_TRANSLATE_MAX_TOKENS = 32768;
const DEFAULT_TRANSLATE_TEMPERATURE = 0.2;

export type TranslationAttemptContext = {
  modelId: string;
  modelKey: string;
  modelDisplayName: string;
  providerId: string;
  providerDisplayName: string;
  pluginId: string;
  maxTokens: number;
  temperature: number | null;
  thinking: boolean | null;
};

export type TranslationExecutionContext = {
  systemPrompt: string;
  userPrompt: string;
  profileId: string | null;
  profileName: string | null;
  attempts: TranslationAttemptContext[];
  earlyFailure?: { errorCode: string; message: string };
};

function modelDisplayName(model: ProviderModelDto): string {
  return model.displayNameOverride?.trim() || model.remoteDisplayName?.trim() || model.modelKey;
}

export type TranslationContextSnapshots = {
  providersById: Map<string, ProviderInstanceDto>;
  modelsById: Map<string, ProviderModelDto>;
  profile: TranslationProfileDto | null;
};

export function resolveTranslationContext(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
): TranslationExecutionContext {
  const text = input.text.trim();
  const sourceLang = input.sourceLang.trim();
  const targetLang = input.targetLang.trim();
  if (!text) {
    return early("validation_failed", "Source text must not be empty");
  }
  if (!sourceLang || !targetLang) {
    return early("validation_failed", "Source and target languages are required");
  }

  let systemPrompt = buildDefaultTranslateSystemPrompt(sourceLang, targetLang);
  let userPrompt = text;
  let temperature: number | null = DEFAULT_TRANSLATE_TEMPERATURE;
  let profileMaxTokens: number | null = null;

  const profile = snapshots.profile;
  if (input.profileId) {
    if (!profile) {
      return early("validation_failed", "Selected translation profile was not found");
    }
    if (!profile.enabled) {
      return early("validation_failed", "Selected translation profile is disabled");
    }
    if (input.promptTemplateId && !profile.promptTemplates.some((t) => t.id === input.promptTemplateId)) {
      return early("validation_failed", "Selected prompt template does not belong to this profile");
    }
    const templateId = input.promptTemplateId ?? profile.defaultPromptTemplateId;
    const template = profile.promptTemplates.find((t) => t.id === templateId);
    if (!template) {
      return early("validation_failed", "Selected prompt template does not belong to this profile");
    }
    systemPrompt = renderPromptTemplate(template.systemTemplate, sourceLang, targetLang, text);
    userPrompt = renderPromptTemplate(template.userTemplate, sourceLang, targetLang, text);
    temperature = profile.temperature ?? DEFAULT_TRANSLATE_TEMPERATURE;
    profileMaxTokens = profile.maxOutputTokens ?? null;
  } else if (input.promptTemplateId) {
    return early("validation_failed", "Prompt template override requires a translation profile");
  }

  const modelIds: string[] = [input.modelId];
  if (profile) {
    for (const target of profile.targets) {
      if (!modelIds.includes(target.providerModelId)) {
        modelIds.push(target.providerModelId);
      }
    }
  }

  const attempts: TranslationAttemptContext[] = [];
  for (const modelId of modelIds) {
    const model = snapshots.modelsById.get(modelId);
    if (!model || !model.enabled) {
      continue;
    }
    const provider = snapshots.providersById.get(model.providerInstanceId);
    if (!provider || !provider.enabled) {
      continue;
    }
    const pluginId = (model.adapterId?.trim() || provider.adapterId).trim();
    try {
      const plugin = requireProviderPlugin(pluginId);
      const providerPlugin = requireProviderPlugin(provider.adapterId);
      const modelAuth = plugin.resolveAuthScheme(provider.credentialKind);
      const providerAuth = provider.authScheme as AuthSchemeV1;
      if (
        !isModelApiTypeExecutable({
          providerPluginId: provider.adapterId,
          modelPluginId: pluginId,
          providerAuthScheme: providerAuth,
          modelAuthScheme: modelAuth,
          baseUrlSource: provider.baseUrlSource,
        })
      ) {
        continue;
      }
      // Ensure provider plugin exists for channel-level auth identity.
      void providerPlugin;
      const modelMax =
        model.capabilityOverridesJson?.defaultOutputTokens ?? model.capabilityOverridesJson?.maxOutputTokens ?? null;
      const maxTokens = profileMaxTokens ?? modelMax ?? DEFAULT_TRANSLATE_MAX_TOKENS;
      attempts.push({
        modelId: model.id,
        modelKey: model.modelKey,
        modelDisplayName: modelDisplayName(model),
        providerId: provider.id,
        providerDisplayName: provider.displayName,
        pluginId,
        maxTokens,
        temperature,
        thinking: null,
      });
    } catch (error) {
      if (error instanceof PluginUnavailableError) {
        continue;
      }
      throw error;
    }
  }

  if (attempts.length === 0) {
    return early("validation_failed", "No enabled model/provider available for translation");
  }

  return {
    systemPrompt,
    userPrompt,
    profileId: profile?.id ?? input.profileId ?? null,
    profileName: profile?.name ?? null,
    attempts,
  };
}

function early(errorCode: string, message: string): TranslationExecutionContext {
  return {
    systemPrompt: "",
    userPrompt: "",
    profileId: null,
    profileName: null,
    attempts: [],
    earlyFailure: { errorCode, message },
  };
}
