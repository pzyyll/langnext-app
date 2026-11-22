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
import { sampleSpeechRequest, synthesizeSpeech } from "../tts/channels";
import type { TtsCredentials, TtsFailure } from "../tts/synthesis";
import { canPlayTts, playMp3Bytes } from "../tts/playback";
import { ttsSettingsStore } from "../tts/settings";
import type { TtsChannelId } from "../tts/synthesis";

export type { TtsChannelId };

const TTS_CHANNELS = ["google-cloud", "azure"] as const satisfies readonly TtsChannelId[];

interface TtsSectionProps {
  compact: boolean;
  selectedChannel: TtsChannelId | null;
  onSelectChannel: (channel: TtsChannelId | null) => void;
}

type CredentialState = "unknown" | "readable" | "missing";
type CredentialStates = Record<TtsChannelId, CredentialState>;

function channelName(channel: TtsChannelId): string {
  return t(channel === "azure" ? "settings.tts.azure.channel" : "settings.tts.channel");
}

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

function AzureAvatar() {
  return (
    <Avatar
      size="md"
      accessibilityLabel=""
      fallback={<Icon name="speaker-one" tone="muted-foreground" class="size-4" />}
    />
  );
}

function ChannelAvatar(props: { channel: TtsChannelId }) {
  if (props.channel === "azure") return <AzureAvatar />;
  return <GoogleCloudAvatar />;
}

interface TtsChannelListProps {
  compact: boolean;
  credentialState: CredentialStates;
  onOpenChannel: (channel: TtsChannelId) => void;
  onRowRef: (channel: TtsChannelId, node: ViewRef) => void;
}

function TtsChannelList(props: TtsChannelListProps) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const mutating = signal(false);
  const listError = signal<string | null>(null);

  const handleToggle = async (channel: TtsChannelId, nextEnabled: boolean) => {
    if (mutating()) return;
    listError.set(null);
    mutating.set(true);
    try {
      const result = await ttsSettingsStore.setEnabled(channel, nextEnabled);
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
        {TTS_CHANNELS.map((channel) => (
          <TtsChannelRow
            channel={channel}
            credentialState={props.credentialState[channel]}
            mutating={mutating()}
            onOpen={() => {
              listError.set(null);
              props.onOpenChannel(channel);
            }}
            onToggle={(checked) => void handleToggle(channel, checked)}
            onRowRef={(node) => props.onRowRef(channel, node)}
          />
        ))}
      </Card>

      <If when={listError() !== null}>
        <Text testID="settings-tts-list-error" role="alert" class="px-1 text-sm text-destructive">
          {listError()}
        </Text>
      </If>
    </View>
  );
}

function TtsChannelRow(props: {
  channel: TtsChannelId;
  credentialState: CredentialState;
  mutating: boolean;
  onOpen: () => void;
  onToggle: (checked: boolean) => void;
  onRowRef: (node: ViewRef) => void;
}) {
  const name = () => channelName(props.channel);
  const saved = () => ttsSettingsStore.savedBinding(props.channel);
  const configured = () => saved() !== null;
  const enabled = () => ttsSettingsStore.activeBinding()?.channel === props.channel;
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
  const otherName = () => {
    const active = ttsSettingsStore.activeBinding();
    if (active === null || active.channel === props.channel || enabled()) return null;
    return channelName(active.channel);
  };
  const switchLabel = () => {
    const other = otherName();
    if (other === null) return t("settings.tts.enableLabel", { name: name() });
    return t("settings.tts.switchOffOther", { name: other });
  };

  return (
    <View
      testID={`settings-tts-row-${props.channel}`}
      class={`flex-row items-center gap-1.5 rounded-lg pr-2 hover:bg-accent/60 active:bg-accent ${motion.navigationFeedback}`}
    >
      <Button
        testID={`settings-tts-channel-${props.channel}`}
        ref={(node) => props.onRowRef(node)}
        variant="ghost"
        size="row"
        accessibilityLabel={rowLabel()}
        onPress={props.onOpen}
        class="min-w-0 flex-1 py-2.5 pl-3 pr-2 hover:bg-transparent active:bg-transparent"
      >
        <ChannelAvatar channel={props.channel} />
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="min-w-0 truncate text-sm font-medium text-card-foreground">{name()}</Text>
          <Text
            testID={`settings-tts-summary-${props.channel}`}
            class={`min-w-0 truncate text-xs ${summary().toneClass}`}
          >
            {summary().text}
          </Text>
        </View>
      </Button>

      <Switch
        testID={`settings-tts-toggle-${props.channel}`}
        variant="inline"
        checked={enabled()}
        disabled={props.mutating || !configured()}
        accessibilityLabel={switchLabel()}
        tooltip={
          !configured()
            ? t("settings.tts.configureBeforeEnable")
            : otherName() === null
              ? undefined
              : switchLabel()
        }
        onChange={props.onToggle}
      />

      <Button
        testID={`settings-tts-open-${props.channel}`}
        variant="ghost"
        size="icon-sm"
        tooltip={t("settings.tts.configureLabel", { name: name() })}
        accessibilityLabel={t("settings.tts.configureLabel", { name: name() })}
        onPress={props.onOpen}
      >
        <Icon name="chevron-right" tone="muted-foreground" class="size-3.5" />
      </Button>
    </View>
  );
}

type PreviewPhase = "idle" | "loading" | "playing";

function previewFailureMessage(channel: TtsChannelId, failure: TtsFailure): string {
  if (failure === "auth") {
    return t(channel === "azure" ? "settings.tts.failure.azureAuth" : "settings.tts.failure.auth");
  }
  if (failure === "rate_limited") return t("settings.tts.failure.azureRateLimited");
  if (failure === "quota") return t("settings.tts.failure.quota");
  return t("settings.tts.failure.playback");
}

function ChannelDetail(props: {
  channel: TtsChannelId;
  compact: boolean;
  credentialState: CredentialState;
}) {
  const entrance = createMotion({ enter: motion.pageEnter });
  const apiKeyDraft = signal("");
  const regionDraft = signal("");
  const error = signal<string | null>(null);
  const previewError = signal<string | null>(null);
  const saving = signal(false);
  const playbackReady = signal(false);
  const phase = signal<PreviewPhase>("idle");
  let apiKeyField: InputRef | undefined;
  let regionTouched = false;
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
    if (props.channel !== "azure" || regionTouched) return;
    const saved = ttsSettingsStore.savedBinding("azure");
    regionDraft.set(saved === null ? "" : saved.region);
  });

  effect(() => {
    void canPlayTts().then((ready) => {
      if (mounted) playbackReady.set(ready);
    });
  });

  const savedBinding = () => ttsSettingsStore.savedBinding(props.channel);
  const regionDirty = () => {
    if (props.channel !== "azure") return false;
    const saved = ttsSettingsStore.savedBinding("azure");
    if (saved === null) return regionDraft().trim().length > 0;
    return regionDraft().trim() !== saved.region;
  };
  const previewLabel = () => {
    if (phase() === "loading") return t("common.cancel");
    if (phase() === "playing") return t("settings.tts.stop");
    return t("settings.tts.preview");
  };
  const previewNote = (): string | undefined => {
    if (!playbackReady()) return t("settings.tts.previewUnavailable");
    if (savedBinding() === null || props.credentialState !== "readable") {
      return t("settings.tts.previewNeedsKey");
    }
    if (phase() === "idle" && apiKeyDraft().trim().length > 0) {
      return t("settings.tts.previewUnsaved");
    }
    if (phase() === "idle" && regionDirty()) return t("settings.tts.previewUnsavedRegion");
    return undefined;
  };
  const previewDisabled = () =>
    phase() === "idle" &&
    (saving() ||
      !playbackReady() ||
      apiKeyDraft().trim().length > 0 ||
      regionDirty() ||
      savedBinding() === null ||
      props.credentialState !== "readable");
  const controlsLocked = () => saving() || phase() !== "idle";
  const saveDisabled = () =>
    controlsLocked() ||
    apiKeyDraft().trim().length === 0 ||
    (props.channel === "azure" && regionDraft().trim().length === 0);

  const handleSave = async () => {
    const apiKey = apiKeyDraft().trim();
    if (saveDisabled()) return;
    error.set(null);
    saving.set(true);
    try {
      const result =
        props.channel === "azure"
          ? await ttsSettingsStore.saveChannel({
              channel: "azure",
              apiKey,
              region: regionDraft().trim(),
            })
          : await ttsSettingsStore.saveChannel({ channel: "google-cloud", apiKey });
      if (!result.ok) {
        error.set(result.message);
        return;
      }
      if (result.binding.channel === "azure") {
        regionTouched = false;
        regionDraft.set(result.binding.region);
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
    const saved = savedBinding();
    if (saved === null) return;
    const token = active.token + 1;
    active.token = token;
    const controller = new AbortController();
    active.abort = controller;
    previewError.set(null);
    phase.set("loading");
    const apiKey = await ttsSettingsStore.readKey(saved.credentialRef);
    if (!mounted || token !== active.token) return;
    const current = savedBinding();
    const bindingChanged =
      current === null ||
      current.credentialRef !== saved.credentialRef ||
      (saved.channel === "azure" &&
        (current.channel !== "azure" || current.region !== saved.region));
    if (apiKey === null || bindingChanged) {
      phase.set("idle");
      previewError.set(t("settings.tts.keyUnreadable"));
      return;
    }
    const credentials: TtsCredentials =
      saved.channel === "azure"
        ? { channel: "azure", apiKey, region: saved.region }
        : { channel: "google-cloud", apiKey };
    const synthesized = await synthesizeSpeech(sampleSpeechRequest(credentials), {
      signal: controller.signal,
    });
    if (!mounted || token !== active.token || controller.signal.aborted) return;
    if (synthesized.status === "cancelled") {
      phase.set("idle");
      return;
    }
    if (synthesized.status === "failed") {
      phase.set("idle");
      previewError.set(previewFailureMessage(props.channel, synthesized.failure));
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
          <ChannelAvatar channel={props.channel} />
          <SectionHeading title={channelName(props.channel)} />
        </View>

        <If when={props.channel === "azure"}>
          <FormField label={t("settings.tts.azure.region")}>
            <Input
              testID="settings-tts-region"
              value={regionDraft()}
              placeholder={t("settings.tts.azure.regionExample")}
              disabled={controlsLocked()}
              accessibilityLabel={t("settings.tts.azure.region")}
              onChange={(value) => {
                regionTouched = true;
                error.set(null);
                regionDraft.set(value);
              }}
            />
          </FormField>
        </If>

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
            disabled={saveDisabled()}
            onPress={() => void handleSave()}
          />
        </View>
      </Card>
    </View>
  );
}

/** Settings section for the text-to-speech channels. */
export function TtsSection(props: TtsSectionProps) {
  const credentialState = signal<CredentialStates>({
    "google-cloud": "unknown",
    azure: "unknown",
  });
  const rowRefs: Partial<Record<TtsChannelId, ViewRef>> = {};
  let returnChannel: TtsChannelId | null = null;
  let restoreFocusOnList = false;

  effect(() => {
    for (const channel of TTS_CHANNELS) {
      const saved = ttsSettingsStore.savedBinding(channel);
      if (saved === null) {
        if (credentialState()[channel] !== "unknown") {
          credentialState.set({ ...credentialState(), [channel]: "unknown" });
        }
        continue;
      }
      const ref = saved.credentialRef;
      void ttsSettingsStore.readKey(ref).then((key) => {
        if (ttsSettingsStore.savedBinding(channel)?.credentialRef !== ref) return;
        const next = key === null ? "missing" : "readable";
        if (credentialState()[channel] === next) return;
        credentialState.set({ ...credentialState(), [channel]: next });
      });
    }
  });

  effect(() => {
    const current = props.selectedChannel;
    if (current !== null) {
      returnChannel = current;
      restoreFocusOnList = true;
      return;
    }
    if (!restoreFocusOnList) return;
    restoreFocusOnList = false;
    const channel = returnChannel;
    queueMicrotask(() => {
      if (props.selectedChannel === null && channel !== null) rowRefs[channel]?.focus();
    });
  });

  const selected = () => props.selectedChannel;

  return (
    <>
      <If when={selected() === null}>
        <TtsChannelList
          compact={props.compact}
          credentialState={credentialState()}
          onOpenChannel={(channel) => props.onSelectChannel(channel)}
          onRowRef={(channel, node) => {
            rowRefs[channel] = node;
          }}
        />
      </If>
      <If when={selected() === "google-cloud"}>
        <ChannelDetail
          channel="google-cloud"
          compact={props.compact}
          credentialState={credentialState()["google-cloud"]}
        />
      </If>
      <If when={selected() === "azure"}>
        <ChannelDetail
          channel="azure"
          compact={props.compact}
          credentialState={credentialState().azure}
        />
      </If>
    </>
  );
}
