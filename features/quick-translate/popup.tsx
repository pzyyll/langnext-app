import {
  batch,
  cleanup,
  Clipboard,
  effect,
  signal,
  Text,
  View,
  type Accessor,
  type InputRef,
} from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Select, type SelectItem } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  LANGUAGE_IDS,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";
import { presetsStore } from "../presets/store";
import type { PresetsStore, TranslationPreset } from "../presets/types";
import {
  resolveInitialPresetLanguages,
  translateWithPreset,
  type TranslateWithPresetInput,
  type TranslateWithPresetOptions,
  type TranslateWithPresetResult,
} from "./translate";

const AUTO_TRANSLATE_DEBOUNCE_MS = 500;
const COPY_FEEDBACK_DURATION_MS = 1500;

type ResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; text: string; modelId: string }
  | { status: "error"; message: string };

export interface QuickTranslatePopupProps {
  sourceText: Accessor<string>;
  onSourceTextChange: (text: string) => void;
  autoTranslate?: Accessor<boolean>;
  onOverlayOpenChange?: (menuId: string, open: boolean) => void;
  onAttachSourceInput?: (input: InputRef | null) => void;
  presetsStore?: Pick<PresetsStore, "load" | "records" | "status">;
  translate?: (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ) => Promise<TranslateWithPresetResult>;
  clipboard?: Pick<typeof Clipboard, "writeText">;
}

function buildSourceLanguageItems(): SelectItem[] {
  return [
    { value: AUTO_LANGUAGE, title: getLanguageLabel(AUTO_LANGUAGE) },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

function buildTargetLanguageItems(): SelectItem[] {
  return LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) }));
}

function buildPresetItems(presets: readonly TranslationPreset[]): SelectItem[] {
  return presets.map((preset) => ({ value: preset.id, title: preset.name }));
}

/** Compact Stage 1 Quick Translate popup body composed inside the floating window or standalone harness. */
export function QuickTranslatePopup(props: QuickTranslatePopupProps) {
  const store = props.presetsStore ?? presetsStore;
  const runTranslate = props.translate ?? translateWithPreset;
  const clipboardApi = props.clipboard ?? Clipboard;
  const isAutoTranslate = () => props.autoTranslate?.() ?? false;

  if (store.status().kind === "idle") {
    void store.load();
  }

  const selectedPresetId = signal<string | null>(null);
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const targetLanguage = signal<TargetLanguageId>("zh");
  const resultState = signal<ResultState>({ status: "idle" });
  const copied = signal(false);
  const copyError = signal<string | null>(null);
  const isComposing = signal(false);

  const enabledPresets = () => store.records().filter((item) => item.enabled);
  const selectedPreset = () =>
    enabledPresets().find((item) => item.id === selectedPresetId()) ?? null;
  const sourceLanguageItems = buildSourceLanguageItems();
  const targetLanguageItems = buildTargetLanguageItems();

  let disposed = false;
  let requestSeq = 0;
  let activeRequestId = 0;
  let activeAbort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDebounce = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const clearCopyFeedback = () => {
    if (copyResetTimer !== null) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    copied.set(false);
    copyError.set(null);
  };

  const invalidateRun = (nextResult: ResultState = { status: "idle" }) => {
    clearDebounce();
    clearCopyFeedback();
    requestSeq += 1;
    activeRequestId = requestSeq;
    activeAbort?.abort();
    activeAbort = null;
    resultState.set(nextResult);
  };

  // Seed default preset and languages once ready, without overriding user edits on non-preset updates.
  effect(() => {
    const status = store.status();
    if (status.kind !== "ready") {
      if (selectedPresetId() !== null) {
        selectedPresetId.set(null);
      }
      return;
    }

    const available = enabledPresets();
    if (available.length === 0) {
      if (selectedPresetId() !== null) {
        selectedPresetId.set(null);
      }
      return;
    }

    const currentId = selectedPresetId();
    if (currentId !== null && available.some((item) => item.id === currentId)) {
      return;
    }

    const first = available[0]!;
    const initial = resolveInitialPresetLanguages(first);
    batch(() => {
      selectedPresetId.set(first.id);
      sourceLanguage.set(initial.sourceLanguage);
      targetLanguage.set(initial.targetLanguage);
    });
  });

  // Cancel any pending debounce timer if automatic mode is turned off.
  effect(() => {
    if (!isAutoTranslate()) {
      clearDebounce();
    }
  });

  cleanup(() => {
    disposed = true;
    invalidateRun();
  });

  const executeTranslate = async (trigger: "manual" | "auto") => {
    clearDebounce();
    clearCopyFeedback();

    const preset = selectedPreset();
    if (store.status().kind !== "ready" || !preset) {
      if (trigger === "manual") {
        resultState.set({
          status: "error",
          message: t("quickTranslate.noEnabledPresets"),
        });
      }
      return;
    }

    const text = props.sourceText();
    if (text.trim().length === 0) {
      if (trigger === "manual") {
        resultState.set({
          status: "error",
          message: t("quickTranslate.error.blankInput"),
        });
      } else {
        resultState.set({ status: "idle" });
      }
      return;
    }

    requestSeq += 1;
    const reqId = requestSeq;
    activeRequestId = reqId;
    activeAbort?.abort();
    const abort = new AbortController();
    activeAbort = abort;
    resultState.set({ status: "loading" });

    let outcome: TranslateWithPresetResult;
    try {
      outcome = await runTranslate(
        {
          preset,
          sourceText: text,
          sourceLanguage: sourceLanguage(),
          targetLanguage: targetLanguage(),
        },
        { signal: abort.signal },
      );
    } catch (error) {
      if (disposed || reqId !== activeRequestId || abort.signal.aborted) {
        return;
      }
      resultState.set({
        status: "error",
        message: error instanceof Error ? error.message : t("protocol.error.networkDefault"),
      });
      return;
    }

    if (disposed || reqId !== activeRequestId || abort.signal.aborted) {
      return;
    }

    if (activeAbort === abort) {
      activeAbort = null;
    }

    if (outcome.ok) {
      resultState.set({
        status: "success",
        text: outcome.text,
        modelId: outcome.modelId,
      });
      return;
    }

    if (!outcome.cancelled) {
      resultState.set({ status: "error", message: outcome.error });
    }
  };

  const scheduleAutoTranslate = () => {
    invalidateRun();
    if (!isAutoTranslate()) return;
    if (store.status().kind !== "ready" || !selectedPreset()) return;
    if (props.sourceText().trim().length === 0) return;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      void executeTranslate("auto");
    }, AUTO_TRANSLATE_DEBOUNCE_MS);
  };

  const handleSourceChange = (nextText: string) => {
    if (nextText === props.sourceText()) return;
    props.onSourceTextChange(nextText);
    scheduleAutoTranslate();
  };

  const handleSourceLanguageChange = (value: string | null) => {
    if (!value || value === sourceLanguage()) return;
    sourceLanguage.set(value as SourceLanguageId);
    scheduleAutoTranslate();
  };

  const handleTargetLanguageChange = (value: string | null) => {
    if (!value || value === targetLanguage()) return;
    targetLanguage.set(value as TargetLanguageId);
    scheduleAutoTranslate();
  };

  const handleSwapLanguages = () => {
    const src = sourceLanguage();
    if (src === AUTO_LANGUAGE) return;
    const tgt = targetLanguage();
    batch(() => {
      sourceLanguage.set(tgt);
      targetLanguage.set(src);
    });
    scheduleAutoTranslate();
  };

  const handlePresetChange = (value: string | null) => {
    if (!value || value === selectedPresetId()) return;
    const nextPreset = enabledPresets().find((item) => item.id === value);
    if (!nextPreset) return;
    const initial = resolveInitialPresetLanguages(nextPreset);
    batch(() => {
      selectedPresetId.set(nextPreset.id);
      sourceLanguage.set(initial.sourceLanguage);
      targetLanguage.set(initial.targetLanguage);
    });
    // Preset change updates languages and invalidates old results without auto-running.
    invalidateRun();
  };

  const handleClearSource = () => {
    props.onSourceTextChange("");
    invalidateRun();
  };

  const handleCopyResult = async () => {
    const current = resultState();
    if (current.status !== "success") return;
    copyError.set(null);
    try {
      await clipboardApi.writeText(current.text);
      if (disposed) return;
      const latest = resultState();
      if (latest.status !== "success" || latest.text !== current.text) {
        return;
      }
      if (copyResetTimer !== null) {
        clearTimeout(copyResetTimer);
      }
      copied.set(true);
      copyResetTimer = setTimeout(() => {
        copyResetTimer = null;
        if (!disposed) {
          copied.set(false);
        }
      }, COPY_FEEDBACK_DURATION_MS);
    } catch {
      if (!disposed) {
        copied.set(false);
        copyError.set(t("quickTranslate.error.copyFailed"));
      }
    }
  };

  const canTranslate = () => store.status().kind === "ready" && selectedPreset() !== null;

  return (
    <View class="gap-2.5 p-3">
      <If when={store.status().kind === "idle" || store.status().kind === "loading"}>
        <Card testID="quick-translate-presets-loading" class="gap-1.5 p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.presetsLoading")}</Text>
        </Card>
      </If>

      <If when={store.status().kind === "error"}>
        <Card
          testID="quick-translate-presets-error"
          class="flex-row items-center justify-between gap-2 border-destructive/40 p-3"
        >
          <Text role="alert" class="min-w-0 flex-1 text-xs text-destructive">
            {(() => {
              const s = store.status();
              return s.kind === "error" ? s.message : "";
            })()}
          </Text>
          <Button
            testID="quick-translate-retry-presets"
            size="xs"
            variant="outline"
            label={t("common.retry")}
            onPress={() => void store.load()}
          />
        </Card>
      </If>

      <If when={store.status().kind === "ready" && enabledPresets().length === 0}>
        <Card testID="quick-translate-no-presets" class="p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.noEnabledPresets")}</Text>
        </Card>
      </If>

      <View class="flex-row items-center gap-2">
        <Select
          testID="quick-translate-preset"
          size="sm"
          class="min-w-0 flex-1"
          items={buildPresetItems(enabledPresets())}
          value={selectedPresetId()}
          placeholder={t("quickTranslate.presetPlaceholder")}
          accessibilityLabel={t("quickTranslate.presetLabel")}
          disabled={!canTranslate()}
          onOpenChange={(open) => props.onOverlayOpenChange?.("preset", open)}
          onChange={handlePresetChange}
        />
        <Button
          testID="quick-translate-submit"
          variant="primary"
          size="sm"
          disabled={!canTranslate()}
          label={t("quickTranslate.translate")}
          onPress={() => void executeTranslate("manual")}
        />
      </View>

      <View class="flex-row items-center gap-1.5">
        <Select
          testID="quick-translate-source-language"
          size="sm"
          class="min-w-0 flex-1"
          items={sourceLanguageItems}
          value={sourceLanguage()}
          accessibilityLabel={t("presets.fields.sourceLanguage")}
          onOpenChange={(open) => props.onOverlayOpenChange?.("source-language", open)}
          onChange={handleSourceLanguageChange}
        />
        <Button
          testID="quick-translate-swap-languages"
          variant="ghost"
          size="icon-sm"
          disabled={sourceLanguage() === AUTO_LANGUAGE}
          tooltip={t("quickTranslate.swapLanguages")}
          accessibilityLabel={t("quickTranslate.swapLanguages")}
          onPress={handleSwapLanguages}
        >
          <Icon
            name="switch"
            tone={sourceLanguage() === AUTO_LANGUAGE ? "muted-foreground" : "foreground"}
            class="size-3.5"
          />
        </Button>
        <Select
          testID="quick-translate-target-language"
          size="sm"
          class="min-w-0 flex-1"
          items={targetLanguageItems}
          value={targetLanguage()}
          accessibilityLabel={t("presets.fields.targetLanguage")}
          onOpenChange={(open) => props.onOverlayOpenChange?.("target-language", open)}
          onChange={handleTargetLanguageChange}
        />
      </View>

      <View class="gap-1.5">
        <Textarea
          testID="quick-translate-source"
          autoFocus
          submitBehavior={isAutoTranslate() ? "newline" : "submit"}
          value={props.sourceText()}
          placeholder={t("quickTranslate.sourcePlaceholder")}
          accessibilityLabel={t("quickTranslate.sourceLabel")}
          inputClass="min-h-16"
          onChange={handleSourceChange}
          onSubmit={() => {
            if (isComposing() || isAutoTranslate()) return;
            void executeTranslate("manual");
          }}
          onCompositionChange={({ composing }) => isComposing.set(composing)}
          ref={(node) => props.onAttachSourceInput?.(node)}
        />
        <If when={props.sourceText().length > 0}>
          <View class="flex-row justify-end">
            <Button
              testID="quick-translate-clear"
              size="xs"
              variant="ghost"
              label={t("common.clearInput")}
              onPress={handleClearSource}
            />
          </View>
        </If>
      </View>

      <If when={resultState().status !== "idle"}>
        <Card class="gap-2 p-3">
          <If when={resultState().status === "loading"}>
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
          </If>

          <If when={resultState().status === "error"}>
            <Text testID="quick-translate-error" role="alert" class="text-xs text-destructive">
              {(() => {
                const state = resultState();
                return state.status === "error" ? state.message : "";
              })()}
            </Text>
          </If>

          <If when={resultState().status === "success"}>
            <View class="gap-2">
              <View selectable>
                <Text
                  testID="quick-translate-result-text"
                  class="text-sm leading-relaxed text-foreground"
                >
                  {(() => {
                    const state = resultState();
                    return state.status === "success" ? state.text : "";
                  })()}
                </Text>
              </View>
              <View class="flex-row items-center justify-between gap-2">
                <Button
                  testID="quick-translate-copy"
                  size="xs"
                  variant="outline"
                  accessibilityLabel={
                    copied() ? t("quickTranslate.copied") : t("quickTranslate.copy")
                  }
                  label={copied() ? t("quickTranslate.copied") : t("quickTranslate.copy")}
                  onPress={() => void handleCopyResult()}
                >
                  <Icon
                    name={copied() ? "check" : "copy"}
                    tone={copied() ? "success" : "muted-foreground"}
                    class="size-3.5"
                  />
                </Button>
              </View>
              <If when={copyError() !== null}>
                <Text
                  testID="quick-translate-copy-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {copyError() ?? ""}
                </Text>
              </If>
            </View>
          </If>
        </Card>
      </If>
    </View>
  );
}
