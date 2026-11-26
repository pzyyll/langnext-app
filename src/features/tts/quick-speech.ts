// ABOUTME: Prepares the active TTS channel through its definition before any network call.
// ABOUTME: The definition owns voice resolution, text limits, and failure messages.
import { t } from "nsh/i18n";
import type {
  ChannelBinding,
  ChannelCollection,
  PrepareResult,
} from "../../framework/integrations";
import type { LanguageId } from "../../framework/languages";
import { ttsChannels } from "./store";
import type { TtsChannelInput, TtsFailure } from "./synthesis";

/** The collection methods quick speech needs; isolated tests override the credential read. */
export type QuickSpeechChannels = Pick<
  ChannelCollection,
  "activeChannel" | "definition" | "readCredential"
>;

export interface PreparedQuickSpeech {
  channel: string;
  input: TtsChannelInput;
}

export type QuickSpeechPreparation =
  | { ok: true; speech: PreparedQuickSpeech }
  | { ok: false; message: string };

function signatureOf(
  channels: QuickSpeechChannels,
  active: { id: string; binding: ChannelBinding },
): string {
  return channels.definition(active.id)?.signature?.(active.binding) ?? "";
}

/** Resolves a local refusal or the prepared request. It does not call a speech service. */
export async function prepareQuickSpeech(
  input: { text: string; language: LanguageId },
  channels: QuickSpeechChannels = ttsChannels,
): Promise<QuickSpeechPreparation> {
  const active = channels.activeChannel();
  if (active === null) return { ok: false, message: t("quickTranslate.speakOff") };
  const definition = channels.definition(active.id);
  if (definition === null || definition.prepare === undefined) {
    return { ok: false, message: t("quickTranslate.speakOff") };
  }
  const prepared = definition.prepare(active.binding, {
    text: input.text,
    language: input.language,
  }) as PrepareResult<TtsChannelInput>;
  if (!prepared.ok) return prepared;

  const credential = await channels.readCredential(active.binding.credentialRef);
  const current = channels.activeChannel();
  const changed =
    current === null ||
    current.id !== active.id ||
    current.binding.credentialRef !== active.binding.credentialRef ||
    signatureOf(channels, current) !== signatureOf(channels, active);
  if (credential === null || changed) {
    return { ok: false, message: t("settings.tts.keyUnreadable") };
  }
  return { ok: true, speech: { channel: active.id, input: prepared.input } };
}

/** A stable message for a synthesis or playback failure. Provider text stays out. */
export function quickSpeechFailureMessage(failure: TtsFailure, channelId?: string): string {
  const definition = channelId === undefined ? null : ttsChannels.definition(channelId);
  const key = definition?.failureKey(failure) ?? null;
  // The settings surface owns the sample message; Quick Translate keeps its own playback line.
  if (key === null || key === "settings.tts.failure.playback") {
    return t("quickTranslate.speakPlayback");
  }
  return t(key);
}
