// ABOUTME: Resolve translation execution context from Query-backed DTOs.
// ABOUTME: Branches LLM model-chain vs plugin service-integration execution.
import type {
  AuthSchemeV1,
  IntegrationInstanceDto,
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

export type LlmTranslationExecutionContext = {
  kind: "llm";
  systemPrompt: string;
  userPrompt: string;
  profileId: string | null;
  profileName: string | null;
  attempts: TranslationAttemptContext[];
  earlyFailure?: { errorCode: string; message: string };
};

export type ServiceTranslationExecutionContext = {
  kind: "service_integration";
  profileId: string;
  profileName: string;
  integrationInstanceId: string;
  integrationDisplayName: string;
  translateCapabilityId: string;
  detectCapabilityId: string | null;
  capabilityLabel: string;
  earlyFailure?: { errorCode: string; message: string };
};

export type TranslationExecutionContext = LlmTranslationExecutionContext | ServiceTranslationExecutionContext;

function modelDisplayName(model: ProviderModelDto): string {
  return model.displayNameOverride?.trim() || model.remoteDisplayName?.trim() || model.modelKey;
}

export type TranslationContextSnapshots = {
  providersById: Map<string, ProviderInstanceDto>;
  modelsById: Map<string, ProviderModelDto>;
  profile: TranslationProfileDto | null;
  /** Integration instances keyed by id (required for plugin profiles). */
  integrationsById?: Map<string, IntegrationInstanceDto>;
};

export function isLlmProfile(profile: TranslationProfileDto): boolean {
  return profile.engine.kind === "llm_model_chain";
}

export function isPluginProfile(profile: TranslationProfileDto): boolean {
  return profile.engine.kind === "plugin_capability";
}

export function resolveTranslationContext(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
): TranslationExecutionContext {
  const text = input.text.trim();
  const sourceLang = input.sourceLang.trim();
  const targetLang = input.targetLang.trim();
  if (!text) {
    return earlyLlm("validation_failed", "Source text must not be empty");
  }
  if (!sourceLang || !targetLang) {
    return earlyLlm("validation_failed", "Source and target languages are required");
  }

  const profile = snapshots.profile;
  if (profile && isPluginProfile(profile)) {
    return resolveServiceContext(input, profile, snapshots);
  }

  return resolveLlmContext(input, snapshots);
}

function resolveServiceContext(
  input: TranslateInput,
  profile: TranslationProfileDto,
  snapshots: TranslationContextSnapshots,
): ServiceTranslationExecutionContext {
  if (!profile.enabled) {
    return earlyService(profile, "validation_failed", "Selected translation profile is disabled");
  }
  if (input.promptTemplateId) {
    return earlyService(profile, "validation_failed", "Prompt templates are not used by service profiles");
  }
  const engine = profile.engine;
  if (engine.kind !== "plugin_capability") {
    return earlyService(profile, "validation_failed", "Selected translation profile is not a service profile");
  }
  const integration = snapshots.integrationsById?.get(engine.integrationInstanceId);
  if (!integration) {
    return earlyService(profile, "plugin_missing", "Integration instance is unavailable");
  }
  // Only ready integrations are executable; other states stay visible but fail closed.
  if (!integration.enabled || integration.effectiveStatus === "disabled") {
    return earlyService(profile, "integration_disabled", "Integration instance is disabled", integration);
  }
  if (integration.effectiveStatus === "plugin_missing") {
    return earlyService(profile, "plugin_missing", "Plugin definition is missing", integration);
  }
  if (integration.effectiveStatus === "unconfigured") {
    return earlyService(
      profile,
      "integration_unconfigured",
      "Integration instance requires configuration",
      integration,
    );
  }
  if (integration.effectiveStatus === "unvalidated") {
    return earlyService(profile, "integration_unvalidated", "Integration instance requires validation", integration);
  }
  if (integration.effectiveStatus === "degraded") {
    return earlyService(profile, "integration_degraded", "Integration instance is degraded", integration);
  }
  if (integration.effectiveStatus !== "ready") {
    return earlyService(profile, "invalid_configuration", "Integration instance is not ready", integration);
  }

  return {
    kind: "service_integration",
    profileId: profile.id,
    profileName: profile.name,
    integrationInstanceId: integration.id,
    integrationDisplayName: integration.displayName,
    translateCapabilityId: engine.translateCapabilityId,
    detectCapabilityId: engine.detectCapabilityId ?? null,
    capabilityLabel: engine.translateCapabilityId,
  };
}

function resolveLlmContext(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
): LlmTranslationExecutionContext {
  const text = input.text.trim();
  const sourceLang = input.sourceLang.trim();
  const targetLang = input.targetLang.trim();

  let systemPrompt = buildDefaultTranslateSystemPrompt(sourceLang, targetLang);
  let userPrompt = text;
  let temperature: number | null = DEFAULT_TRANSLATE_TEMPERATURE;
  let profileMaxTokens: number | null = null;

  const profile = snapshots.profile;
  if (input.profileId) {
    if (!profile) {
      return earlyLlm("validation_failed", "Selected translation profile was not found");
    }
    if (!profile.enabled) {
      return earlyLlm("validation_failed", "Selected translation profile is disabled");
    }
    if (profile.engine.kind !== "llm_model_chain") {
      return earlyLlm("validation_failed", "Selected translation profile is not an LLM profile");
    }
    if (input.promptTemplateId && !profile.promptTemplates.some((t) => t.id === input.promptTemplateId)) {
      return earlyLlm("validation_failed", "Selected prompt template does not belong to this profile");
    }
    const templateId = input.promptTemplateId ?? profile.engine.defaultPromptTemplateId;
    const template = profile.promptTemplates.find((t) => t.id === templateId);
    if (!template) {
      return earlyLlm("validation_failed", "Selected prompt template does not belong to this profile");
    }
    systemPrompt = renderPromptTemplate(template.systemTemplate, sourceLang, targetLang, text);
    userPrompt = renderPromptTemplate(template.userTemplate, sourceLang, targetLang, text);
    temperature = profile.engine.temperature ?? DEFAULT_TRANSLATE_TEMPERATURE;
    profileMaxTokens = profile.engine.maxOutputTokens ?? null;
  } else if (input.promptTemplateId) {
    return earlyLlm("validation_failed", "Prompt template override requires a translation profile");
  }

  const modelIds: string[] = [];
  if (input.modelId) {
    modelIds.push(input.modelId);
  }
  if (profile && profile.engine.kind === "llm_model_chain") {
    for (const target of profile.targets) {
      if (!modelIds.includes(target.providerModelId)) {
        modelIds.push(target.providerModelId);
      }
    }
  }
  if (modelIds.length === 0) {
    return earlyLlm("validation_failed", "No model selected for translation");
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
    return earlyLlm("validation_failed", "No enabled model/provider available for translation");
  }

  return {
    kind: "llm",
    systemPrompt,
    userPrompt,
    profileId: profile?.id ?? input.profileId ?? null,
    profileName: profile?.name ?? null,
    attempts,
  };
}

function earlyLlm(errorCode: string, message: string): LlmTranslationExecutionContext {
  return {
    kind: "llm",
    systemPrompt: "",
    userPrompt: "",
    profileId: null,
    profileName: null,
    attempts: [],
    earlyFailure: { errorCode, message },
  };
}

function earlyService(
  profile: TranslationProfileDto,
  errorCode: string,
  message: string,
  integration?: IntegrationInstanceDto,
): ServiceTranslationExecutionContext {
  const engine = profile.engine.kind === "plugin_capability" ? profile.engine : null;
  return {
    kind: "service_integration",
    profileId: profile.id,
    profileName: profile.name,
    integrationInstanceId: engine?.integrationInstanceId ?? "",
    integrationDisplayName: integration?.displayName ?? "",
    translateCapabilityId: engine?.translateCapabilityId ?? "",
    detectCapabilityId: engine?.detectCapabilityId ?? null,
    capabilityLabel: engine?.translateCapabilityId ?? "service",
    earlyFailure: { errorCode, message },
  };
}
