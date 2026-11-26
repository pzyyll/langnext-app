// ABOUTME: Shared settings preview: prepares and plays one fixed sample through the definition.
// ABOUTME: The definition owns voice, text, and failure mapping; this component owns playback state.
import { cleanup, effect, signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../../components/ui/button";
import type {
  CapabilityChannelDefinition,
  ChannelBinding,
  ChannelSettingsHost,
} from "../../../framework/integrations";
import type { LanguageId } from "../../../framework/languages";
import type { TtsChannelInput, TtsSynthesis } from "../types";
import { ttsHostServices } from "./host";

type PreviewPhase = "idle" | "loading" | "playing";

/** One channel's sample button and its failure line. */
export interface TtsSamplePreviewProps<C> {
  definition: CapabilityChannelDefinition<C, TtsChannelInput, TtsSynthesis>;
  /** Draft binding; read at press time so a preview reflects unsaved edits. */
  binding: ChannelBinding<C>;
  host: ChannelSettingsHost;
  language: () => LanguageId;
  /** Why the button refuses to start, from the definition's draft rules. */
  disabled: () => boolean;
  note: () => string | undefined;
  /** Optional line above the button, such as the resolved Google voice. */
  label?: () => string | null;
  labelClass?: () => string;
  labelTestID?: string;
}

/** Plays one fixed sample through the definition's own prepare and execute hooks. */
export function TtsSamplePreview<C>(props: TtsSamplePreviewProps<C>) {
  const phase = signal<PreviewPhase>("idle");
  const error = signal<string | null>(null);
  const ready = signal(false);
  let mounted = true;
  let token = 0;
  let abort: AbortController | null = null;
  let stop: (() => void) | null = null;

  cleanup(() => {
    mounted = false;
    token += 1;
    abort?.abort();
    abort = null;
    stop?.();
    stop = null;
  });

  effect(() => props.host.onPreviewBusyChange?.(phase() !== "idle"));
  cleanup(() => props.host.onPreviewBusyChange?.(false));

  effect(() => {
    const audio = props.host.audio;
    if (audio === undefined) {
      ready.set(false);
      return;
    }
    void audio.canPlay().then((can) => {
      if (mounted) ready.set(can);
    });
  });

  const controlsLocked = () => phase() !== "idle";
  const previewDisabled = () => {
    if (controlsLocked()) return false;
    return !ready() || props.disabled();
  };
  const previewNote = (): string | undefined => {
    if (!ready()) return t("settings.tts.previewUnavailable");
    return props.disabled() ? props.note() : undefined;
  };
  const previewLabel = (): string => {
    if (phase() === "loading") return t("common.cancel");
    if (phase() === "playing") return t("settings.tts.stop");
    return t("settings.tts.preview");
  };

  const cancel = () => {
    token += 1;
    abort?.abort();
    abort = null;
    stop?.();
    stop = null;
    phase.set("idle");
    error.set(null);
  };

  const fail = (message: string) => {
    phase.set("idle");
    error.set(message);
  };

  const play = async () => {
    if (phase() === "loading" || phase() === "playing") {
      cancel();
      return;
    }
    if (previewDisabled()) return;
    const current = token + 1;
    token = current;
    const controller = new AbortController();
    abort = controller;
    error.set(null);
    phase.set("loading");
    const credential = await props.host.readSavedCredential();
    if (!mounted || current !== token) return;
    if (credential === null) {
      fail(t("settings.tts.previewNeedsKey"));
      return;
    }
    const binding = props.binding;
    const requested: TtsChannelInput = {
      text: "",
      language: props.language(),
      sample: true,
      signal: controller.signal,
    };
    const prepared = props.definition.prepare?.(binding, requested);
    if (prepared === undefined) {
      fail(t("settings.tts.previewUnavailable"));
      return;
    }
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const synthesized = await props.definition.execute(
      binding,
      prepared.input,
      ttsHostServices(credential),
    );
    if (!mounted || current !== token || controller.signal.aborted) return;
    if (synthesized.status === "cancelled") {
      phase.set("idle");
      return;
    }
    if (synthesized.status === "failed") {
      const key = props.definition.failureKey(synthesized.failure);
      fail(t(key ?? "settings.tts.failure.playback"));
      return;
    }
    const audio = props.host.audio;
    if (audio === undefined) {
      fail(t("settings.tts.previewUnavailable"));
      return;
    }
    const playback = audio.playMp3(synthesized.audio, {
      onPlaying: () => {
        if (!mounted || current !== token) {
          playback.stop();
          return;
        }
        phase.set("playing");
      },
    });
    stop = () => playback.stop();
    const played = await playback.result;
    if (!mounted || current !== token) return;
    stop = null;
    phase.set("idle");
    if (played.status === "failed") error.set(t("settings.tts.failure.playback"));
  };

  return (
    <>
      <If when={error() !== null}>
        <Text testID="settings-tts-preview-error" role="alert" class="text-sm text-destructive">
          {error()}
        </Text>
      </If>
      <If when={props.label !== undefined && props.label() !== null}>
        <Text
          testID={props.labelTestID}
          class={props.labelClass?.() ?? "text-xs text-muted-foreground"}
        >
          {props.label?.()}
        </Text>
      </If>
      <View class="flex-row justify-end">
        <Button
          testID="settings-tts-preview"
          variant="outline"
          size="sm"
          label={previewLabel()}
          disabled={previewDisabled()}
          tooltip={previewDisabled() ? previewNote() : undefined}
          onPress={() => void play()}
        />
      </View>
    </>
  );
}
