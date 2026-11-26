// ABOUTME: Runs one prepared speech request through the contribution that owns the channel.
// ABOUTME: Dispatch uses contribution hooks only; no feature code branches on a channel id.
import type { HostServices } from "../../framework/contributions";
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

/** One prepared call: the contribution id plus the input it prepared. */
export interface PreparedSpeech {
  channel: string;
  input: TtsChannelInput;
}

/**
 * Executes one prepared speech request. The credential is read for this call only
 * and the contribution receives the host fetch boundary.
 */
export async function synthesizeSpeech(
  speech: PreparedSpeech,
  options?: { signal?: AbortSignal },
): Promise<TtsSynthesis> {
  const contribution = ttsChannels.contribution(speech.channel);
  const binding = ttsChannels.binding(speech.channel);
  if (contribution === null || binding === null) {
    return { status: "failed", failure: "malformed" };
  }
  const credential = await ttsChannels.readCredential(binding.credentialRef);
  if (credential === null) return { status: "failed", failure: "auth" };
  const input =
    options?.signal !== undefined ? { ...speech.input, signal: options.signal } : speech.input;
  const host: HostServices = { credential, models: unsupportedModels, log };
  return (await contribution.execute(binding, input, host)) as TtsSynthesis;
}
