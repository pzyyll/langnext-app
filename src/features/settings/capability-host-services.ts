// ABOUTME: Adapters from feature services to the capability settings host.
import type { ChannelAudioHost, ModelPurpose } from "../../framework/contributions";
import { readAvailableModelChoices, resolveModelBindingInfo } from "../presets/model-choices";
import { canPlayTts, playMp3Bytes } from "../tts/playback";
import type { CapabilitySectionHostServices } from "./capability-section";

/** Model picker and binding status for an AI-backed channel's Settings. */
export function modelHostServices(
  purpose: ModelPurpose,
  onManageModels?: () => void,
): CapabilitySectionHostServices {
  return {
    modelChoices: () => readAvailableModelChoices(purpose),
    resolveModelBinding: (modelId) => {
      const info = resolveModelBindingInfo(modelId, purpose);
      return info.available
        ? { ok: true, label: info.label }
        : { ok: false, reason: info.reason ?? "", label: info.label };
    },
    ...(onManageModels !== undefined ? { onManageModels } : {}),
  };
}

/** Playback host for the text-to-speech sample preview. */
export const ttsAudioHost: ChannelAudioHost = {
  canPlay: canPlayTts,
  playMp3: (bytes, hooks) => playMp3Bytes(bytes, hooks),
};
