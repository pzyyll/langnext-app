import {
  cleanup,
  createMotion,
  effect,
  Image,
  signal,
  Text,
  View,
  type InputRef,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import googleCloudIcon from "../../assets/icons/google-cloud.svg";
import { motion } from "../../components/motion";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast";
import { FormField } from "../../modules/ai/ui/form-field";
import {
  createGoogleCloudTtsClient,
  TTS_SAMPLE_LANGUAGE_CODE,
  TTS_SAMPLE_TEXT,
  TTS_SAMPLE_VOICE_NAME,
  type GoogleCloudTtsFailure,
} from "../tts/google-cloud";
import { canPlayTts, playMp3Bytes } from "../tts/playback";
import { ttsSettingsStore } from "../tts/settings";

export type TtsChannelId = "google-cloud";

interface TtsSectionProps {
  compact: boolean;
  selectedChannel: TtsChannelId | null;
  onSelectChannel: (channel: TtsChannelId | null) => void;
}

type CredentialState = "unknown" | "readable" | "missing";

function GoogleCloudAvatar() {
  return (
    <Avatar
      size="md"
      accessibilityLabel=""
      fallback={
        <Image
          src={googleCloudIcon}
          accessibilityElementsHidden={true}
          class="size-4 overflow-hidden"
        />
      }
    />
  );
}

interface TtsChannelListProps {
  compact: boolean;
  credentialState: CredentialState;
  onOpenChannel: () => void;
  onRowRef: (node: ViewRef) => void;
}

function TtsChannelList(props: TtsChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const listError = signal<string | null>(null);
  const name = () => t("settings.tts.channel");
  const configured = () => ttsSettingsStore.savedBinding() !== null;
  const enabled = () => ttsSettingsStore.isEnabled();
  const summary = (): { text: string; toneClass: string } => {
    if (!configured()) {
      return { text: t("settings.tts.notConfigured"), toneClass: "text-muted-foreground" };
    }
    if (props.credentialState === "missing") {
      return { text: t("settings.tts.keyUnreadable"), toneClass: "text-destructive" };
    }
    return { text: t("settings.tts.configured"), toneClass: "text-muted-foreground" };
  };
  const rowLabel = () =>
    t("settings.tts.itemLabel", {
      name: name(),
      status: configured()
        ? enabled()
          ? t("models.filter.enabled")
          : t("models.filter.disabled")
        : t("settings.tts.notConfigured"),
    });

  const handleToggle = async (nextEnabled: boolean) => {
    if (mutating()) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await ttsSettingsStore.setEnabled(nextEnabled);
      if (!result.ok) listError.set(result.message);
    } finally {
      mutating.set(false);
    }
  };

  return (
    <View
      // Runtime native entrance motion fades the channel list without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <If when={ttsSettingsStore.loadError() !== null}>
        <Text testID="settings-tts-load-error" role="alert" class="text-sm text-destructive">
          {ttsSettingsStore.loadError()!.message}
        </Text>
      </If>

      <Card testID="settings-tts-card" class={props.compact ? "gap-1 p-2" : "gap-1 p-3"}>
        <View
          testID="settings-tts-row-google-cloud"
          class={`flex-row items-center gap-1.5 rounded-lg pr-2 hover:bg-accent/60 active:bg-accent ${motion.navigationFeedback}`}
        >
          <Button
            testID="settings-tts-channel-google-cloud"
            ref={(node) => props.onRowRef(node)}
            variant="ghost"
            size="row"
            accessibilityLabel={rowLabel()}
            onPress={() => {
              listError.set(null);
              props.onOpenChannel();
            }}
            class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
          >
            <GoogleCloudAvatar />
            <View class="min-w-0 flex-1 gap-0.5">
              <Text class="min-w-0 truncate text-sm font-medium text-card-foreground">
                {name()}
              </Text>
              <Text
                testID="settings-tts-summary-google-cloud"
                class={`min-w-0 truncate text-xs ${summary().toneClass}`}
              >
                {summary().text}
              </Text>
            </View>
          </Button>

          <Switch
            testID="settings-tts-toggle-google-cloud"
            variant="inline"
            checked={enabled()}
            disabled={mutating() || !configured()}
            accessibilityLabel={t("settings.tts.enableLabel", { name: name() })}
            tooltip={!configured() ? t("settings.tts.configureBeforeEnable") : undefined}
            onChange={(checked) => void handleToggle(checked)}
          />

          <Button
            testID="settings-tts-open-google-cloud"
            variant="ghost"
            size="icon-sm"
            tooltip={t("settings.tts.configureLabel", { name: name() })}
            accessibilityLabel={t("settings.tts.configureLabel", { name: name() })}
            onPress={() => {
              listError.set(null);
              props.onOpenChannel();
            }}
          >
            <Icon name="chevron-right" tone="muted-foreground" class="size-3.5" />
          </Button>
        </View>
      </Card>

      <If when={listError() !== null}>
        <Text testID="settings-tts-list-error" role="alert" class="px-1 text-sm text-destructive">
          {listError()}
        </Text>
      </If>
    </View>
  );
}

type PreviewPhase = "idle" | "loading" | "playing";

function previewFailureMessage(failure: GoogleCloudTtsFailure): string {
  if (failure === "auth") return t("settings.tts.failure.auth");
  if (failure === "quota") return t("settings.tts.failure.quota");
  return t("settings.tts.failure.playback");
}

function GoogleCloudDetail(props: { compact: boolean; credentialState: CredentialState }) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const apiKeyDraft = signal("");
  const error = signal<string | null>(null);
  const previewError = signal<string | null>(null);
  const saving = signal(false);
  const playbackReady = signal(false);
  const phase = signal<PreviewPhase>("idle");
  let apiKeyField: InputRef | undefined;
  let mounted = true;
  const active = {
    token: 0,
    abort: null as AbortController | null,
    stop: null as (() => void) | null,
  };

  cleanup(() => {
    mounted = false;
    active.token += 1;
    active.abort?.abort();
    active.stop?.();
    active.stop = null;
  });

  effect(() => {
    void canPlayTts().then((ready) => {
      if (mounted) playbackReady.set(ready);
    });
  });

  const previewLabel = () => {
    if (phase() === "loading") return t("common.cancel");
    if (phase() === "playing") return t("settings.tts.stop");
    return t("settings.tts.preview");
  };
  const previewNote = (): string | undefined => {
    if (!playbackReady()) return t("settings.tts.previewUnavailable");
    if (ttsSettingsStore.savedBinding() === null || props.credentialState !== "readable") {
      return t("settings.tts.previewNeedsKey");
    }
    if (phase() === "idle" && apiKeyDraft().trim().length > 0)
      return t("settings.tts.previewUnsaved");
    return undefined;
  };
  const previewDisabled = () =>
    phase() === "idle" &&
    (saving() ||
      !playbackReady() ||
      apiKeyDraft().trim().length > 0 ||
      ttsSettingsStore.savedBinding() === null ||
      props.credentialState !== "readable");
  const controlsLocked = () => saving() || phase() !== "idle";

  const handleSave = async () => {
    const apiKey = apiKeyDraft().trim();
    if (controlsLocked() || apiKey.length === 0) return;
    error.set(null);
    saving.set(true);
    try {
      const result = await ttsSettingsStore.saveGoogleCloud({ apiKey });
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      apiKeyDraft.set("");
      if (mounted) apiKeyField?.blur();
      toast.success(t("settings.tts.saved"));
    } finally {
      saving.set(false);
    }
  };

  const handlePreview = async () => {
    if (phase() === "loading") {
      active.token += 1;
      active.abort?.abort();
      active.stop?.();
      active.stop = null;
      phase.set("idle");
      previewError.set(null);
      return;
    }
    if (phase() === "playing") {
      active.token += 1;
      active.stop?.();
      active.stop = null;
      phase.set("idle");
      previewError.set(null);
      return;
    }
    if (previewDisabled()) return;
    const saved = ttsSettingsStore.savedBinding();
    if (saved === null) return;
    const token = active.token + 1;
    active.token = token;
    const controller = new AbortController();
    active.abort = controller;
    previewError.set(null);
    phase.set("loading");
    const apiKey = await ttsSettingsStore.readGoogleCloudKey(saved.credentialRef);
    if (!mounted || token !== active.token) return;
    if (apiKey === null || saved.credentialRef !== ttsSettingsStore.savedBinding()?.credentialRef) {
      phase.set("idle");
      previewError.set(t("settings.tts.keyUnreadable"));
      return;
    }
    const synthesized = await createGoogleCloudTtsClient().synthesize(
      {
        apiKey,
        text: TTS_SAMPLE_TEXT,
        languageCode: TTS_SAMPLE_LANGUAGE_CODE,
        voiceName: TTS_SAMPLE_VOICE_NAME,
      },
      { signal: controller.signal },
    );
    if (!mounted || token !== active.token || controller.signal.aborted) return;
    if (synthesized.status === "cancelled") {
      phase.set("idle");
      return;
    }
    if (synthesized.status === "failed") {
      phase.set("idle");
      previewError.set(previewFailureMessage(synthesized.failure));
      return;
    }
    const playback = playMp3Bytes(synthesized.audio, {
      onPlaying: () => {
        if (!mounted || token !== active.token) {
          playback.stop();
          return;
        }
        phase.set("playing");
      },
    });
    active.stop = () => playback.stop();
    const played = await playback.result;
    if (!mounted || token !== active.token) return;
    active.stop = null;
    phase.set("idle");
    if (played.status === "failed") previewError.set(t("settings.tts.failure.playback"));
  };

  return (
    <View
      // Runtime native entrance motion fades the channel detail without fading the opaque background.
      style={entrance.style}
      class="gap-4"
    >
      <Card testID="settings-tts-detail-card" class={props.compact ? "gap-4 p-4" : "gap-5 p-6"}>
        <View class="min-w-0 flex-row items-center gap-3">
          <GoogleCloudAvatar />
          <SectionHeading title={t("settings.tts.channel")} />
        </View>

        <FormField label={t("settings.tts.apiKey")}>
          <Input
            testID="settings-tts-api-key"
            ref={(node) => {
              apiKeyField = node;
            }}
            value={apiKeyDraft()}
            placeholder={
              props.credentialState === "readable" ? t("settings.tts.savedKey") : undefined
            }
            masked={true}
            disabled={controlsLocked()}
            accessibilityLabel={t("settings.tts.apiKey")}
            onChange={(value) => {
              error.set(null);
              apiKeyDraft.set(value);
            }}
          />
        </FormField>

        <If when={props.credentialState === "missing"}>
          <Text testID="settings-tts-key-missing" role="alert" class="text-sm text-destructive">
            {t("settings.tts.keyUnreadable")}
          </Text>
        </If>

        <If when={error() !== null}>
          <Text testID="settings-tts-error" role="alert" class="text-sm text-destructive">
            {error()}
          </Text>
        </If>

        <If when={previewError() !== null}>
          <Text testID="settings-tts-preview-error" role="alert" class="text-sm text-destructive">
            {previewError()}
          </Text>
        </If>

        <View class="flex-row justify-end gap-2">
          <Button
            testID="settings-tts-preview"
            variant="outline"
            size="sm"
            label={previewLabel()}
            disabled={previewDisabled()}
            tooltip={previewDisabled() ? previewNote() : undefined}
            onPress={() => void handlePreview()}
          />
          <Button
            testID="settings-tts-save"
            variant="primary"
            size="sm"
            label={saving() ? t("common.saving") : t("common.save")}
            disabled={controlsLocked() || apiKeyDraft().trim().length === 0}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>
    </View>
  );
}

/** Settings section for the Google Cloud text-to-speech channel. */
export function TtsSection(props: TtsSectionProps) {
  const credentialState = signal<CredentialState>("unknown");
  let rowRef: ViewRef | undefined;
  let restoreFocusOnList = false;

  effect(() => {
    const saved = ttsSettingsStore.savedBinding();
    if (saved === null) {
      credentialState.set("unknown");
      return;
    }
    const ref = saved.credentialRef;
    void ttsSettingsStore.readGoogleCloudKey(ref).then((key) => {
      if (ttsSettingsStore.savedBinding()?.credentialRef !== ref) return;
      credentialState.set(key === null ? "missing" : "readable");
    });
  });

  effect(() => {
    const current = props.selectedChannel;
    if (current !== null) {
      restoreFocusOnList = true;
      return;
    }
    if (!restoreFocusOnList) return;
    restoreFocusOnList = false;
    queueMicrotask(() => {
      if (props.selectedChannel === null) rowRef?.focus();
    });
  });

  return (
    <If
      when={props.selectedChannel === null}
      else={<GoogleCloudDetail compact={props.compact} credentialState={credentialState()} />}
    >
      <TtsChannelList
        compact={props.compact}
        credentialState={credentialState()}
        onOpenChannel={() => props.onSelectChannel("google-cloud")}
        onRowRef={(node) => {
          rowRef = node;
        }}
      />
    </If>
  );
}
