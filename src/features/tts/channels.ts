// ABOUTME: Runs one prepared speech request through the definition that owns the channel.
// ABOUTME: Dispatch uses definition hooks only; no feature code branches on a channel id.
import type { HostServices } from "../../framework/integrations";
import { createLogger } from "../../services/log";
import { ttsChannels } from "./store";
import type { TtsChannelInput, TtsSynthesis } from "./synthesis";

const log = createLogger("tts/synthesis");

const unsupportedModels: HostServices["models"] = {
  resolveSaved: async () => ({ ok: false, reason: "TTS does not resolve saved models." }),
  generateText: async () => {
    throw new Error("TTS does not generate text through a model.");
  },
  generateTextFromImage: async () => {
    throw new Error("TTS does not read images through a model.");
  },
};

/** One prepared call: the definition id plus the input it prepared. */
export interface PreparedSpeech {
  channel: string;
  input: TtsChannelInput;
}

/**
 * Executes one prepared speech request. The credential is read for this call only
 * and the definition receives the host fetch boundary.
 */
export async function synthesizeSpeech(
  speech: PreparedSpeech,
  options?: { signal?: AbortSignal },
): Promise<TtsSynthesis> {
  const definition = ttsChannels.definition(speech.channel);
  const binding = ttsChannels.binding(speech.channel);
  if (definition === null || binding === null) {
    return { status: "failed", failure: "malformed" };
  }
  const credential = await ttsChannels.readCredential(binding.credentialRef);
  if (credential === null) return { status: "failed", failure: "auth" };
  const input =
    options?.signal !== undefined ? { ...speech.input, signal: options.signal } : speech.input;
  const host: HostServices = { credential, models: unsupportedModels, log };
  return (await definition.execute(binding, input, host)) as TtsSynthesis;
}
