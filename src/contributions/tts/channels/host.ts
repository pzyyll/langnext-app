// ABOUTME: Host services a TTS call or sample needs; TTS uses only the credential, fetch, and log.
import type { CredentialRecord, HostServices } from "../../../framework/contributions";
import { createLogger } from "../../../services/log";

const log = createLogger("tts/channels");

const unsupportedModels: HostServices["models"] = {
  resolveSaved: async () => ({ ok: false, reason: "TTS does not resolve saved models." }),
  generateText: async () => {
    throw new Error("TTS does not generate text through a model.");
  },
  generateTextFromImage: async () => {
    throw new Error("TTS does not read images through a model.");
  },
};

/** Wraps one call's credential and the host fetch boundary for a TTS contribution. */
export function ttsHostServices(
  credential: CredentialRecord | null,
  fetchImpl?: HostServices["fetchImpl"],
): HostServices {
  return {
    credential,
    models: unsupportedModels,
    log,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  };
}
