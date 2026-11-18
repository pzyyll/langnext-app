import {
  batch,
  cleanup,
  effect,
  List,
  signal,
  Text,
  View,
  windowSize,
  type InputRef,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import type { NavigationLeaveGuard } from "../../components/layout/navigation-leave-guard";
import { motion } from "../../components/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { toast } from "../../components/ui/toast";
import { modelsStore } from "../models/store";
import {
  cloneDraft,
  createDraftFromPreset,
  createEmptyDraft,
  draftToSaveInput,
  isDraftDirty,
  type PresetDraft,
} from "./draft";
import { PresetEditor } from "./editor";
import { readAvailableModelChoices, summarizePresetModels } from "./model-choices";
import { presetsStore } from "./store";
import { PresetsStoreError, type PresetValidationField, type TranslationPreset } from "./types";

interface PresetsPageProps {
  onRegisterLeaveGuard?: (guard: NavigationLeaveGuard) => () => void;
  onNavigateToModels?: () => void;
}

/** Main-window workspace for managing AI translation presets. */
export function PresetsPage(props: PresetsPageProps) {
  if (presetsStore.status().kind === "idle") {
    void presetsStore.load();
  }

  const selectedIdSignal = signal<string | null>(null);
  const draftSignal = signal<PresetDraft | null>(null);
  const baselineSignal = signal<PresetDraft | null>(null);
  const autoFocusNameSignal = signal<boolean>(false);
  const errorMessageSignal = signal<string | null>(null);
  const errorFieldSignal = signal<PresetValidationField | null>(null);
  const errorFallbackIndexSignal = signal<number | null>(null);

  let nameInputRef: InputRef | null = null;
  let primaryModelRef: ViewRef | null = null;
  const fallbackRefs = new Map<number, ViewRef>();
  let temperatureInputRef: InputRef | null = null;
  let maxTokensInputRef: InputRef | null = null;

  const unregisterGuard = props.onRegisterLeaveGuard?.(() => !presetsStore.mutating());
  if (unregisterGuard) {
    cleanup(unregisterGuard);
  }

  effect(() => {
    const status = presetsStore.status();
    const records = presetsStore.records();
    if (status.kind !== "ready") return;
    if (draftSignal() !== null) return;
    const first = records[0] ?? null;
    if (!first) return;
    const nextDraft = createDraftFromPreset(first);
    batch(() => {
      selectedIdSignal.set(first.id);
      baselineSignal.set(cloneDraft(nextDraft));
      draftSignal.set(nextDraft);
    });
  });

  const compactLayout = () => windowSize().width < 860;
  const railWidthClass = () => (compactLayout() ? "w-48" : "w-60");
  const status = () => presetsStore.status();
  const isReady = () => status().kind === "ready";
  const isLoading = () => {
    const kind = status().kind;
    return kind === "idle" || kind === "loading";
  };
  const loadError = () => {
    const current = status();
    return current.kind === "error" ? current.message : null;
  };
  const isDirty = () => {
    const current = draftSignal();
    const baseline = baselineSignal();
    if (!current || !baseline) return false;
    return isDraftDirty(current, baseline);
  };
  const modelChoices = () => readAvailableModelChoices();
  const modelsError = () => modelsStore.channelsError();

  const clearErrors = () => {
    errorMessageSignal.set(null);
    errorFieldSignal.set(null);
    errorFallbackIndexSignal.set(null);
  };

  const focusField = (field: PresetValidationField | undefined, fallbackIndex?: number) => {
    if (field === "primaryModel") {
      queueMicrotask(() => primaryModelRef?.focus());
      return;
    }
    if (field === "fallbackModel" && fallbackIndex !== undefined) {
      queueMicrotask(() => fallbackRefs.get(fallbackIndex)?.focus());
      return;
    }
    if (field === "temperature") {
      queueMicrotask(() => temperatureInputRef?.focus());
      return;
    }
    if (field === "maxOutputTokens") {
      queueMicrotask(() => maxTokensInputRef?.focus());
      return;
    }
    if (field === "name" || !field) {
      queueMicrotask(() => nameInputRef?.focus());
    }
  };

  const applySavedRecord = (record: TranslationPreset) => {
    const nextDraft = createDraftFromPreset(record);
    batch(() => {
      selectedIdSignal.set(record.id);
      baselineSignal.set(cloneDraft(nextDraft));
      draftSignal.set(nextDraft);
      autoFocusNameSignal.set(false);
      clearErrors();
    });
  };

  const selectEmptyOrFirst = () => {
    const first = presetsStore.records()[0] ?? null;
    if (first) {
      applySavedRecord(first);
      return;
    }
    batch(() => {
      selectedIdSignal.set(null);
      baselineSignal.set(null);
      draftSignal.set(null);
      autoFocusNameSignal.set(false);
      clearErrors();
    });
  };

  const startNewDraft = () => {
    if (!isReady() || presetsStore.mutating()) return;
    const empty = createEmptyDraft();
    batch(() => {
      selectedIdSignal.set(null);
      baselineSignal.set(cloneDraft(empty));
      draftSignal.set(empty);
      autoFocusNameSignal.set(true);
      clearErrors();
    });
    queueMicrotask(() => nameInputRef?.focus());
  };

  const selectSavedPreset = (id: string) => {
    if (presetsStore.mutating()) return;
    const target = presetsStore.records().find((item) => item.id === id);
    if (!target) return;
    applySavedRecord(target);
  };

  const updateDraft = (patch: Partial<PresetDraft>) => {
    const current = draftSignal();
    if (!current) return;
    batch(() => {
      draftSignal.set({ ...current, ...patch });
      if (errorMessageSignal() !== null) {
        clearErrors();
      }
    });
  };

  const handleSave = async () => {
    const current = draftSignal();
    if (!current || presetsStore.mutating()) return;
    clearErrors();
    try {
      const saved = await presetsStore.save(draftToSaveInput(current));
      applySavedRecord(saved);
      toast.success(t("presets.editor.saved"));
    } catch (error) {
      if (error instanceof PresetsStoreError) {
        errorMessageSignal.set(error.message);
        errorFieldSignal.set(error.field ?? null);
        errorFallbackIndexSignal.set(error.fallbackIndex ?? null);
        focusField(error.field, error.fallbackIndex);
        return;
      }
      errorMessageSignal.set(error instanceof Error ? error.message : String(error));
      errorFieldSignal.set(null);
      errorFallbackIndexSignal.set(null);
    }
  };

  const handleCancel = () => {
    const current = draftSignal();
    if (!current || presetsStore.mutating()) return;
    clearErrors();
    if (current.sourceId === null) {
      selectEmptyOrFirst();
      return;
    }
    const baseline = baselineSignal();
    if (baseline) {
      draftSignal.set(cloneDraft(baseline));
    }
  };

  const isNewDraft = () => draftSignal()?.sourceId === null;

  return (
    <>
      <View
        testID="presets-rail"
        class={`${railWidthClass()} shrink-0 border-r border-border bg-background`}
      >
        <View class="h-12 shrink-0 flex-row items-center justify-between border-b border-border px-4">
          <Text role="header" class="text-sm font-semibold text-foreground">
            {t("presets.list.title")}
          </Text>
          <Button
            testID="add-preset-button"
            variant="ghost"
            size="icon-sm"
            disabled={!isReady() || presetsStore.mutating()}
            tooltip={t("presets.action.add")}
            accessibilityLabel={t("presets.action.add")}
            onPress={() => startNewDraft()}
          >
            <Icon name="plus" tone="foreground" class="size-4" />
          </Button>
        </View>

        <If
          when={isLoading()}
          else={
            <If
              when={Boolean(loadError())}
              else={
                <If
                  when={presetsStore.records().length > 0 || isNewDraft()}
                  else={
                    <View class="p-4">
                      <Text class="text-xs text-muted-foreground">{t("presets.list.empty")}</Text>
                    </View>
                  }
                >
                  <View class="min-h-0 flex-1">
                    <If when={isNewDraft()}>
                      <View class="px-2 pt-2">
                        <View
                          testID="preset-draft-item"
                          class={`flex-row items-center gap-2 rounded-lg border border-border bg-accent px-2.5 py-2 ${motion.navigationFeedback}`}
                        >
                          <View class="min-w-0 flex-1 gap-0.5">
                            <View class="flex-row items-center gap-1.5">
                              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                {draftSignal()?.name.trim() || t("presets.editor.untitled")}
                              </Text>
                              <Badge tone="warning" label={t("presets.editor.unsaved")} />
                            </View>
                            <Text class="truncate text-xs text-muted-foreground">
                              {summarizePresetModels(
                                draftSignal()?.primaryModelId
                                  ? [draftSignal()!.primaryModelId!]
                                  : [],
                              )}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </If>

                    <If when={presetsStore.records().length > 0}>
                      <List
                        each={presetsStore.records()}
                        keyExtractor={(item) => item.id}
                        estimatedItemSize={56}
                        contentClass="gap-1 p-2"
                        class="min-h-0 flex-1"
                      >
                        {(preset) => {
                          const isSelected = () =>
                            !isNewDraft() && selectedIdSignal() === preset().id;
                          return (
                            <View
                              class={`rounded-lg border ${motion.navigationFeedback}`}
                              classList={{
                                "border-border bg-accent": isSelected(),
                                "border-transparent hover:bg-accent/50 active:bg-accent":
                                  !isSelected(),
                              }}
                            >
                              <Button
                                testID={`preset-item-${preset().id}`}
                                variant="ghost"
                                size="row"
                                selected={isSelected()}
                                accessibilityLabel={t("presets.list.itemLabel", {
                                  name: preset().name,
                                  status: preset().enabled
                                    ? t("presets.list.enabled")
                                    : t("presets.list.disabled"),
                                })}
                                onPress={() => selectSavedPreset(preset().id)}
                                class="w-full min-w-0 flex-1 hover:bg-transparent active:bg-transparent"
                              >
                                <View class="min-w-0 flex-1 gap-0.5">
                                  <View class="flex-row items-center gap-1.5">
                                    <Text class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                      {preset().name}
                                    </Text>
                                    <Badge
                                      tone={preset().enabled ? "success" : "neutral"}
                                      label={
                                        preset().enabled
                                          ? t("presets.list.enabled")
                                          : t("presets.list.disabled")
                                      }
                                    />
                                  </View>
                                  <Text class="truncate text-xs text-muted-foreground">
                                    {summarizePresetModels(preset().engine.modelIds)}
                                  </Text>
                                </View>
                              </Button>
                            </View>
                          );
                        }}
                      </List>
                    </If>
                  </View>
                </If>
              }
            >
              <View class="gap-3 p-4">
                <Text role="alert" class="text-xs text-destructive">
                  {loadError()}
                </Text>
                <Button
                  testID="presets-retry-button"
                  size="sm"
                  variant="outline"
                  label={t("common.retry")}
                  onPress={() => void presetsStore.load()}
                />
              </View>
            </If>
          }
        >
          <View class="p-4">
            <Text class="text-xs text-muted-foreground">{t("presets.list.loading")}</Text>
          </View>
        </If>
      </View>

      <If
        when={draftSignal() !== null}
        else={
          <View class="min-w-0 flex-1 items-center justify-center gap-4 p-8">
            <Icon name="file-text" tone="muted-foreground" class="size-10 opacity-50" />
            <Text role="header" class="text-2xl font-semibold text-foreground">
              {t("presets.title")}
            </Text>
            <If when={isReady()}>
              <Button
                testID="empty-add-preset-button"
                variant="primary"
                size="md"
                accessibilityLabel={t("presets.action.add")}
                onPress={() => startNewDraft()}
              >
                <Icon name="plus" tone="primary-foreground" class="size-4" />
                <Text class="text-sm font-medium text-primary-foreground">
                  {t("presets.action.add")}
                </Text>
              </Button>
            </If>
          </View>
        }
      >
        <PresetEditor
          draft={draftSignal()!}
          dirty={isDirty()}
          saving={presetsStore.mutating()}
          modelChoices={modelChoices()}
          modelsError={modelsError()}
          errorMessage={errorMessageSignal()}
          errorField={errorFieldSignal()}
          errorFallbackIndex={errorFallbackIndexSignal()}
          autoFocusName={autoFocusNameSignal()}
          onChange={(patch) => updateDraft(patch)}
          onSave={() => void handleSave()}
          onCancel={() => handleCancel()}
          onManageModels={() => props.onNavigateToModels?.()}
          onNameRef={(node) => {
            nameInputRef = node;
          }}
          onPrimaryModelRef={(node) => {
            primaryModelRef = node;
          }}
          onFallbackRef={(index, node) => {
            if (node) {
              fallbackRefs.set(index, node);
            } else {
              fallbackRefs.delete(index);
            }
          }}
          onTemperatureRef={(node) => {
            temperatureInputRef = node;
          }}
          onMaxTokensRef={(node) => {
            maxTokensInputRef = node;
          }}
        />
      </If>
    </>
  );
}
