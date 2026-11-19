import {
  batch,
  cleanup,
  effect,
  List,
  setAccessibilityFocus,
  signal,
  Text,
  View,
  type InputRef,
  type ViewRef,
} from "nsh";
import { t } from "nsh/i18n";
import type { NavigationLeaveGuard } from "../../components/layout/navigation-leave-guard";
import { SplitPane } from "../../components/layout/split-pane";
import { motion } from "../../components/motion";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
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
import { PresetEditor, type FocusableEditorField } from "./editor";
import { readAvailableModelChoices, summarizePresetModels } from "./model-choices";
import type { TemplateEditableField } from "./prompt-templates";
import { dismissSkippedNotice, skippedNoticeDismissed } from "./skipped-notice";
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

  const initialFirst =
    presetsStore.status().kind === "ready" ? (presetsStore.records()[0] ?? null) : null;
  const initialDraft = initialFirst ? createDraftFromPreset(initialFirst) : null;

  const selectedIdSignal = signal<string | null>(initialFirst?.id ?? null);
  const selectedTemplateIdSignal = signal<string | null>(
    initialFirst?.engine.templates[0]?.id ?? null,
  );
  const draftSignal = signal<PresetDraft | null>(initialDraft);
  const baselineSignal = signal<PresetDraft | null>(initialDraft ? cloneDraft(initialDraft) : null);
  const autoFocusNameSignal = signal<boolean>(false);
  const errorMessageSignal = signal<string | null>(null);
  const errorFieldSignal = signal<PresetValidationField | null>(null);
  const errorFallbackIndexSignal = signal<number | null>(null);
  const errorTemplateIdSignal = signal<string | null>(null);
  const discardOpenSignal = signal<boolean>(false);
  const deleteTargetSignal = signal<{ id: string; name: string } | null>(null);
  const deleteErrorSignal = signal<string | null>(null);

  let nameInputRef: InputRef | null = null;
  let primaryModelRef: ViewRef | null = null;
  const fallbackRefs = new Map<number, ViewRef>();
  let temperatureInputRef: InputRef | null = null;
  let maxTokensInputRef: InputRef | null = null;
  let deleteButtonRef: ViewRef | null = null;
  let railAddButtonRef: ViewRef | null = null;
  let emptyAddButtonRef: ViewRef | null = null;
  let discardKeepEditingRef: ViewRef | null = null;
  let deleteCancelRef: ViewRef | null = null;
  const presetRowRefs = new Map<string, ViewRef>();
  const templateFieldRefs = new Map<string, Partial<Record<TemplateEditableField, InputRef>>>();
  let pendingTemplateFocus: { templateId: string; field: TemplateEditableField } | null = null;
  let lastFocusedField: FocusableEditorField = { kind: "name" };
  let pendingDiscardAction: (() => void) | null = null;
  let restoreDiscardFocusOnClose = false;
  let pendingPostDeleteFocus:
    | { kind: "empty" }
    | { kind: "row"; id: string }
    | { kind: "deleteButton" }
    | null = null;

  const isDirty = () => {
    const current = draftSignal();
    const baseline = baselineSignal();
    if (!current || !baseline) return false;
    return isDraftDirty(current, baseline);
  };

  const focusNode = (node: ViewRef | InputRef | null | undefined) => {
    if (!node) return;
    node.focus();
    setAccessibilityFocus(node);
  };

  const restoreLastEditorFocus = () => {
    const target: FocusableEditorField = lastFocusedField;
    queueMicrotask(() => {
      switch (target.kind) {
        case "name":
          focusNode(nameInputRef);
          break;
        case "temperature":
          focusNode(temperatureInputRef);
          break;
        case "maxOutputTokens":
          focusNode(maxTokensInputRef);
          break;
        case "template":
          focusNode(templateFieldRefs.get(target.templateId)?.[target.field]);
          break;
      }
    });
  };

  const unregisterGuard = props.onRegisterLeaveGuard?.((proceed) => {
    if (presetsStore.mutating()) {
      return false;
    }
    if (!isDirty()) {
      return true;
    }
    pendingDiscardAction = proceed;
    discardOpenSignal.set(true);
    return false;
  });
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
      selectedTemplateIdSignal.set(first.engine.templates[0]?.id ?? null);
      baselineSignal.set(cloneDraft(nextDraft));
      draftSignal.set(nextDraft);
    });
  });

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
  const skippedNotice = () => {
    const current = status();
    if (skippedNoticeDismissed() || current.kind !== "ready" || current.skippedCount === 0) {
      return null;
    }
    return current.skippedCount === 1
      ? t("presets.list.skippedOne")
      : t("presets.list.skippedMany", { count: current.skippedCount });
  };
  const modelChoices = () => readAvailableModelChoices();
  const modelsError = () => modelsStore.channelsError();

  const clearErrors = () => {
    errorMessageSignal.set(null);
    errorFieldSignal.set(null);
    errorFallbackIndexSignal.set(null);
    errorTemplateIdSignal.set(null);
    pendingTemplateFocus = null;
  };

  const focusField = (
    field: PresetValidationField | undefined,
    fallbackIndex?: number,
    templateId?: string,
  ) => {
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
    if (
      (field === "templateName" || field === "systemTemplate" || field === "userTemplate") &&
      templateId
    ) {
      const targetField: TemplateEditableField = field;
      if (selectedTemplateIdSignal() !== templateId) {
        pendingTemplateFocus = { templateId, field: targetField };
        selectedTemplateIdSignal.set(templateId);
      }
      queueMicrotask(() => {
        const node = templateFieldRefs.get(templateId)?.[targetField];
        if (node) {
          pendingTemplateFocus = null;
          node.focus();
        }
      });
      return;
    }
    if (field === "name" || !field) {
      queueMicrotask(() => nameInputRef?.focus());
    }
  };

  const applySavedRecord = (record: TranslationPreset) => {
    const nextDraft = createDraftFromPreset(record);
    const samePreset = selectedIdSignal() === record.id;
    if (!samePreset) {
      lastFocusedField = { kind: "name" };
    }
    const currentTpl = selectedTemplateIdSignal();
    const keepTpl =
      samePreset &&
      currentTpl !== null &&
      record.engine.templates.some((tpl) => tpl.id === currentTpl);
    batch(() => {
      selectedIdSignal.set(record.id);
      selectedTemplateIdSignal.set(keepTpl ? currentTpl : (record.engine.templates[0]?.id ?? null));
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
      selectedTemplateIdSignal.set(null);
      baselineSignal.set(null);
      draftSignal.set(null);
      autoFocusNameSignal.set(false);
      clearErrors();
    });
  };

  const guardNavigation = (action: () => void) => {
    if (presetsStore.mutating()) return;
    if (!isDirty()) {
      action();
      return;
    }
    pendingDiscardAction = action;
    discardOpenSignal.set(true);
  };

  const openFreshDraft = () => {
    const empty = createEmptyDraft();
    lastFocusedField = { kind: "name" };
    batch(() => {
      selectedIdSignal.set(null);
      selectedTemplateIdSignal.set(empty.templates[0]?.id ?? null);
      baselineSignal.set(cloneDraft(empty));
      draftSignal.set(empty);
      autoFocusNameSignal.set(true);
      clearErrors();
    });
    queueMicrotask(() => nameInputRef?.focus());
  };

  const startNewDraft = () => {
    if (!isReady() || presetsStore.mutating()) return;
    guardNavigation(() => openFreshDraft());
  };

  const selectSavedPreset = (id: string) => {
    if (presetsStore.mutating()) return;
    if (!isNewDraft() && selectedIdSignal() === id) return;
    const target = presetsStore.records().find((item) => item.id === id);
    if (!target) return;
    guardNavigation(() => applySavedRecord(target));
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
        errorTemplateIdSignal.set(error.templateId ?? null);
        focusField(error.field, error.fallbackIndex, error.templateId);
        return;
      }
      errorMessageSignal.set(error instanceof Error ? error.message : String(error));
      errorFieldSignal.set(null);
      errorFallbackIndexSignal.set(null);
      errorTemplateIdSignal.set(null);
    }
  };

  const handleCancel = () => {
    const current = draftSignal();
    if (!current || presetsStore.mutating()) return;
    const resetDraft = () => {
      clearErrors();
      if (current.sourceId === null) {
        selectEmptyOrFirst();
        return;
      }
      const baseline = baselineSignal();
      if (baseline) {
        const currentTpl = selectedTemplateIdSignal();
        const keepTpl =
          currentTpl !== null && baseline.templates.some((tpl) => tpl.id === currentTpl);
        batch(() => {
          selectedTemplateIdSignal.set(keepTpl ? currentTpl : (baseline.templates[0]?.id ?? null));
          draftSignal.set(cloneDraft(baseline));
        });
      }
    };
    guardNavigation(resetDraft);
  };

  const handleManageModels = () => {
    if (presetsStore.mutating()) return;
    props.onNavigateToModels?.();
  };

  const cancelDiscardPrompt = () => {
    pendingDiscardAction = null;
    discardOpenSignal.set(false);
  };

  const confirmDiscardPrompt = () => {
    const action = pendingDiscardAction;
    pendingDiscardAction = null;
    restoreDiscardFocusOnClose = false;
    discardOpenSignal.set(false);
    action?.();
  };

  const openDeleteDialog = () => {
    const current = draftSignal();
    if (!current || !current.sourceId || presetsStore.mutating()) return;
    const saved = presetsStore.records().find((item) => item.id === current.sourceId);
    const displayName = saved?.name ?? (current.name.trim() || t("presets.editor.untitled"));
    batch(() => {
      deleteErrorSignal.set(null);
      deleteTargetSignal.set({ id: current.sourceId!, name: displayName });
    });
  };

  const closeDeleteDialog = () => {
    if (presetsStore.mutating()) return;
    batch(() => {
      deleteErrorSignal.set(null);
      deleteTargetSignal.set(null);
    });
  };

  const confirmDelete = async () => {
    const target = deleteTargetSignal();
    if (!target || presetsStore.mutating()) return;
    deleteErrorSignal.set(null);
    const recordsBefore = presetsStore.records();
    const deletedIndex = recordsBefore.findIndex((item) => item.id === target.id);

    try {
      await presetsStore.remove(target.id);
      const remaining = presetsStore.records();
      if (remaining.length === 0) {
        pendingPostDeleteFocus = { kind: "empty" };
        selectEmptyOrFirst();
      } else {
        const nextIndex = deletedIndex >= 0 ? Math.min(deletedIndex, remaining.length - 1) : 0;
        const nextPreset = remaining[nextIndex]!;
        pendingPostDeleteFocus = { kind: "row", id: nextPreset.id };
        applySavedRecord(nextPreset);
      }
      deleteTargetSignal.set(null);
      toast.success(t("presets.editor.deleted", { name: target.name }));
    } catch (error) {
      const detail =
        error instanceof PresetsStoreError && error.cause instanceof Error
          ? error.cause.message
          : error instanceof Error
            ? error.message
            : String(error);
      deleteErrorSignal.set(t("presets.delete.error", { detail }));
    }
  };

  const closeSkippedNotice = async () => {
    const saved = dismissSkippedNotice();
    if (!presetsStore.mutating()) focusNode(railAddButtonRef);
    if (!(await saved)) toast.error(t("presets.list.dismissSkippedNoticeFailed"));
  };

  const isNewDraft = () => draftSignal()?.sourceId === null;

  return (
    <>
      <SplitPane
        page="presets"
        handleAccessibilityLabel={t("presets.list.resizeLabel")}
        rail={
          <View testID="presets-rail" class="min-w-0 flex-1 bg-background">
            <View class="h-14 shrink-0 flex-row items-center justify-between gap-2 px-4">
              <Text role="header" class="min-w-0 truncate text-sm font-semibold text-foreground">
                {t("presets.list.title")}
              </Text>
              <Button
                testID="add-preset-button"
                ref={(node) => {
                  railAddButtonRef = node;
                }}
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

            <If when={skippedNotice() !== null}>
              <View class="shrink-0 flex-row items-start gap-2 px-4 pb-3 pt-1">
                <Text
                  testID="presets-skipped-notice"
                  class="min-w-0 flex-1 py-1 text-xs text-muted-foreground"
                >
                  {skippedNotice()}
                </Text>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="shrink-0"
                  accessibilityLabel={t("presets.list.dismissSkippedNotice")}
                  onPress={() => void closeSkippedNotice()}
                >
                  <Icon name="close" tone="muted-foreground" class="size-3.5" />
                </Button>
              </View>
            </If>

            <If
              when={isLoading()}
              else={
                <If
                  when={Boolean(loadError())}
                  else={
                    <If
                      when={presetsStore.records().length > 0 || isNewDraft()}
                      else={
                        <View class="px-4 pb-4 pt-1">
                          <Text class="text-xs text-muted-foreground">
                            {t("presets.list.empty")}
                          </Text>
                        </View>
                      }
                    >
                      <View class="min-h-0 flex-1">
                        <If when={isNewDraft()}>
                          <View class="px-2 pb-1">
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
                            contentClass="gap-1 px-2 pb-2"
                            class="min-h-0 flex-1"
                          >
                            {(preset) => {
                              let rowBtnRef: ViewRef | null = null;
                              effect(() => {
                                const id = preset().id;
                                if (rowBtnRef) {
                                  presetRowRefs.set(id, rowBtnRef);
                                }
                                cleanup(() => {
                                  if (presetRowRefs.get(id) === rowBtnRef) {
                                    presetRowRefs.delete(id);
                                  }
                                });
                              });
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
                                    ref={(node) => {
                                      rowBtnRef = node;
                                      presetRowRefs.set(preset().id, node);
                                    }}
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
                  <View class="gap-3 px-4 pb-4 pt-1">
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
              <View class="px-4 pb-4 pt-1">
                <Text class="text-xs text-muted-foreground">{t("presets.list.loading")}</Text>
              </View>
            </If>
          </View>
        }
        detail={
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
                    ref={(node) => {
                      emptyAddButtonRef = node;
                    }}
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
            <Each
              of={draftSignal() ? [draftSignal()!] : []}
              key={(item) => item.sourceId ?? "__new__"}
            >
              {(draftItem) => (
                <PresetEditor
                  draft={draftItem()}
                  dirty={isDirty()}
                  saving={presetsStore.mutating()}
                  selectedTemplateId={selectedTemplateIdSignal()}
                  modelChoices={modelChoices()}
                  modelsError={modelsError()}
                  errorMessage={errorMessageSignal()}
                  errorField={errorFieldSignal()}
                  errorFallbackIndex={errorFallbackIndexSignal()}
                  errorTemplateId={errorTemplateIdSignal()}
                  autoFocusName={autoFocusNameSignal()}
                  onChange={(patch) => updateDraft(patch)}
                  onSelectTemplate={(templateId) => selectedTemplateIdSignal.set(templateId)}
                  onSave={() => void handleSave()}
                  onCancel={() => handleCancel()}
                  onDelete={() => openDeleteDialog()}
                  onManageModels={() => handleManageModels()}
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
                  onDeleteRef={(node) => {
                    deleteButtonRef = node;
                  }}
                  onTemplateFieldRef={(templateId, field, node) => {
                    const existing = templateFieldRefs.get(templateId) ?? {};
                    existing[field] = node;
                    templateFieldRefs.set(templateId, existing);
                    if (
                      pendingTemplateFocus &&
                      pendingTemplateFocus.templateId === templateId &&
                      pendingTemplateFocus.field === field
                    ) {
                      pendingTemplateFocus = null;
                      queueMicrotask(() => node.focus());
                    }
                  }}
                  onClearTemplateRefs={(templateId) => {
                    templateFieldRefs.delete(templateId);
                  }}
                  onFieldFocus={(target) => {
                    lastFocusedField = target;
                  }}
                />
              )}
            </Each>
          </If>
        }
      />

      <ConfirmDialog
        testID="preset-discard-dialog"
        cancelTestID="preset-discard-keep-editing"
        confirmTestID="preset-discard-confirm"
        open={discardOpenSignal()}
        title={t("presets.discard.title")}
        description={t("presets.discard.description")}
        cancelLabel={t("presets.discard.keepEditing")}
        confirmLabel={t("presets.discard.confirm")}
        cancelRef={(node) => {
          discardKeepEditingRef = node;
        }}
        onOpen={() => {
          restoreDiscardFocusOnClose = true;
          focusNode(discardKeepEditingRef);
        }}
        onClose={() => {
          if (restoreDiscardFocusOnClose) {
            restoreDiscardFocusOnClose = false;
            restoreLastEditorFocus();
          }
        }}
        onConfirm={() => confirmDiscardPrompt()}
        onOpenChange={(open) => {
          if (!open) {
            cancelDiscardPrompt();
          }
        }}
      />

      <ConfirmDialog
        testID="preset-delete-dialog"
        cancelTestID="preset-delete-cancel"
        confirmTestID="preset-delete-confirm"
        open={deleteTargetSignal() !== null}
        title={t("presets.delete.title")}
        description={t("presets.delete.description", {
          name: deleteTargetSignal()?.name ?? "",
        })}
        error={deleteErrorSignal()}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmVariant="destructive"
        busy={presetsStore.mutating()}
        cancelRef={(node) => {
          deleteCancelRef = node;
        }}
        onOpen={() => {
          pendingPostDeleteFocus = { kind: "deleteButton" };
          focusNode(deleteCancelRef);
        }}
        onClose={() => {
          const focusTarget = pendingPostDeleteFocus;
          pendingPostDeleteFocus = null;
          if (!focusTarget) return;
          if (focusTarget.kind === "empty") {
            focusNode(emptyAddButtonRef);
          } else if (focusTarget.kind === "row") {
            focusNode(presetRowRefs.get(focusTarget.id));
          } else {
            focusNode(deleteButtonRef);
          }
        }}
        onConfirm={() => void confirmDelete()}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteDialog();
          }
        }}
      />
    </>
  );
}
