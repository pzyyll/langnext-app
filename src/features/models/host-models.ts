import type {
  HostModels,
  ModelConnectionRoute,
  ModelPurpose,
  ResolvedModelRoute,
} from "../../framework/integrations";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import {
  aiClient,
  type AiClientCallOptions,
  type AiClientInput,
} from "../../modules/ai/runtime/client";
import { resolveSavedModelRequest, type SavedModelRequestResolution } from "./store";

export interface TextHostModelsOptions {
  purpose?: ModelPurpose;
  resolveSavedModelRequest?: (modelId: string) => Promise<SavedModelRequestResolution>;
  generateText?: (
    connection: AiClientInput,
    request: TextGenerationRequest,
    options?: AiClientCallOptions,
  ) => Promise<string>;
}

/** Converts a saved model resolution into the normalized route consumed by capability channels. */
export function toResolvedModelRoute(resolved: SavedModelRequestResolution): ResolvedModelRoute {
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return {
    ok: true,
    modelId: resolved.modelId,
    modelKey: resolved.modelKey,
    connection: {
      providerTypeId: resolved.connection.providerTypeId,
      protocolId: resolved.connection.protocolId,
      baseUrl: resolved.connection.baseUrl,
      credential: resolved.connection.credential,
    },
  };
}

/** Converts a normalized route connection back into an AI client connection descriptor. */
export function toAiClientInput(connection: ModelConnectionRoute): AiClientInput {
  return {
    providerTypeId: connection.providerTypeId as AiClientInput["providerTypeId"],
    protocolId: connection.protocolId as AiClientInput["protocolId"],
    baseUrl: connection.baseUrl,
    credential: connection.credential,
  };
}

/** Builds per-request cached HostModels for text-based capability chains. */
export function createTextHostModels(options: TextHostModelsOptions = {}): HostModels {
  const purpose = options.purpose ?? "text";
  const resolvedCache = new Map<string, Promise<ResolvedModelRoute>>();
  const resolveModel =
    options.resolveSavedModelRequest ??
    ((modelId: string) => resolveSavedModelRequest(modelId, purpose));
  const generate = options.generateText ?? aiClient.generateText;

  return {
    resolveSaved: (modelId) => {
      let pending = resolvedCache.get(modelId);
      if (pending === undefined) {
        pending = resolveModel(modelId).then(toResolvedModelRoute);
        resolvedCache.set(modelId, pending);
      }
      return pending;
    },
    generateText: (connection, request, callOptions) =>
      generate(
        toAiClientInput(connection),
        {
          modelId: request.modelId,
          system: request.system,
          user: request.user,
          disableReasoning: request.disableReasoning,
        },
        callOptions,
      ),
    generateTextFromImage: async () => {
      throw new Error("Text capability host models do not support image generation.");
    },
  };
}
