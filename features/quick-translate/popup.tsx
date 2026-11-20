import { signal, Text, View, type Accessor, type Align, type InputRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Menu, MenuItem } from "../../components/ui/menu";
import { Select, type SelectItem } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { getLanguageLabel } from "../presets/languages";
import type { TranslationPreset } from "../presets/types";
import type { CardViewItem, QuickTranslateSession, SourceDetectionState } from "./session";
import { resolvePresetTemplate } from "./translate";

export interface QuickTranslatePopupProps {
  session: QuickTranslateSession;
  onAttachSourceInput?: (input: InputRef | null) => void;
}

function buildTemplateItems(preset: TranslationPreset | null): SelectItem[] {
  if (!preset || preset.engine.kind !== "ai") return [];
  return preset.engine.templates.map((tpl) => ({
    value: tpl.id,
    title: tpl.name,
  }));
}

function resolveSourceDetectionLabel(state: SourceDetectionState): string | null {
  if (state.status === "detecting") {
    return t("quickTranslate.detectingLanguage");
  }
  if (state.status === "detected") {
    return t("quickTranslate.detectedLanguage", { language: getLanguageLabel(state.language) });
  }
  return null;
}

/** Shared icon-only retry trigger used across card failures, result actions, and preset reload. */
function RetryIconButton(props: { testID: string; onPress: () => void }) {
  return (
    <Button
      testID={props.testID}
      size="icon-sm"
      variant="ghost"
      tooltip={t("common.retry")}
      accessibilityLabel={t("common.retry")}
      onPress={() => props.onPress()}
    >
      <Icon name="refresh" tone="muted-foreground" class="size-3.5" />
    </Button>
  );
}

export interface QuickTranslateAddPresetMenuProps {
  session: QuickTranslateSession;
  align?: Align;
}

/** Renders the icon-only add-preset button so Menu triggers receive the Button element directly. */
function renderAddPresetButton(options: { disabled?: boolean; selected?: boolean }) {
  return (
    <Button
      testID="quick-translate-add-preset"
      size="icon-sm"
      variant="ghost"
      disabled={options.disabled}
      selected={options.selected}
      tooltip={t("quickTranslate.addPreset")}
      accessibilityLabel={t("quickTranslate.addPreset")}
    >
      <Icon
        name="plus"
        tone={options.selected ? "foreground" : "muted-foreground"}
        class="size-3.5"
      />
    </Button>
  );
}

/** Header-ready trigger menu for appending an enabled preset card to the Quick Translate popup. */
export function QuickTranslateAddPresetMenu(props: QuickTranslateAddPresetMenuProps) {
  const addMenuOpen = signal(false);

  return (
    <If when={props.session.canAddPreset()} else={renderAddPresetButton({ disabled: true })}>
      <Menu
        open={addMenuOpen()}
        onOpenChange={(open) => {
          addMenuOpen.set(open);
          props.session.notifyOverlayOpenChange("add-preset", open);
        }}
        placement="bottom"
        align={props.align ?? "start"}
        popupClass="min-w-44 max-h-60"
        trigger={renderAddPresetButton({ selected: addMenuOpen() })}
      >
        <Each of={props.session.enabledPresets()} key={(item) => item.id}>
          {(preset) => (
            <MenuItem
              testID={`quick-translate-add-preset-option-${preset().id}`}
              accessibilityLabel={preset().name}
              label={preset().name}
              onSelect={() => props.session.handleAddPresetCard(preset().id)}
            />
          )}
        </Each>
      </Menu>
    </If>
  );
}

interface PresetCardRowProps {
  card: Accessor<CardViewItem>;
  presets: Accessor<readonly TranslationPreset[]>;
  presetItems: Accessor<SelectItem[]>;
  onOverlayOpenChange: (menuId: string, open: boolean) => void;
  onSelectPreset: (cardId: string, presetId: string | null) => void;
  onSelectTemplate: (cardId: string, templateId: string | null) => void;
  onToggleCollapse: (cardId: string) => void;
  onRemove: (cardId: string) => void;
  onRetry: (cardId: string) => void;
  onCopy: (cardId: string) => void;
}

function PresetCardRow(props: PresetCardRowProps) {
  const resolvedPreset = () =>
    props.presets().find((item) => item.id === props.card().presetId) ?? null;

  const templateItems = () => buildTemplateItems(resolvedPreset());

  const hasTemplates = () => resolvedPreset()?.engine.kind === "ai";

  const activeTemplateValue = () => {
    const preset = resolvedPreset();
    if (!preset) return null;
    const resolution = resolvePresetTemplate(preset, props.card().templateId);
    return resolution ? resolution.template.id : null;
  };

  const hasBody = () => !props.card().collapsed && props.card().result.status !== "idle";

  return (
    <Card testID={`quick-translate-card-${props.card().id}`} class="gap-0 p-0">
      <View
        class={`flex-row items-center gap-1.5 pl-3 pr-1.5 pt-2.5 ${hasBody() ? "pb-2" : "pb-2.5"}`}
      >
        <Select
          testID="quick-translate-preset"
          size="sm"
          class="min-w-0 flex-1"
          items={props.presetItems()}
          value={props.card().presetId}
          placeholder={t("quickTranslate.presetPlaceholder")}
          accessibilityLabel={t("quickTranslate.presetLabel")}
          disabled={props.presetItems().length === 0}
          onOpenChange={(open) => props.onOverlayOpenChange(`card-preset-${props.card().id}`, open)}
          onChange={(value) => props.onSelectPreset(props.card().id, value)}
        />
        <If when={hasTemplates()}>
          <Select
            testID="quick-translate-template"
            size="sm"
            class="min-w-0 flex-1"
            items={templateItems()}
            value={activeTemplateValue()}
            placeholder={t("quickTranslate.templateLabel")}
            accessibilityLabel={t("quickTranslate.templateLabel")}
            disabled={templateItems().length === 0}
            onOpenChange={(open) =>
              props.onOverlayOpenChange(`card-template-${props.card().id}`, open)
            }
            onChange={(value) => props.onSelectTemplate(props.card().id, value)}
          />
        </If>
        <View class="flex-row items-center gap-1">
          <Button
            testID="quick-translate-collapse"
            variant="ghost"
            size="icon-sm"
            tooltip={
              props.card().collapsed
                ? t("quickTranslate.expandCard")
                : t("quickTranslate.collapseCard")
            }
            accessibilityLabel={
              props.card().collapsed
                ? t("quickTranslate.expandCard")
                : t("quickTranslate.collapseCard")
            }
            onPress={() => props.onToggleCollapse(props.card().id)}
          >
            <Icon
              name={props.card().collapsed ? "chevron-down" : "chevron-up"}
              tone="muted-foreground"
              class="size-3.5"
            />
          </Button>
          <Button
            testID="quick-translate-remove"
            variant="ghost"
            size="icon-sm"
            tooltip={t("quickTranslate.removeCard")}
            accessibilityLabel={t("quickTranslate.removeCard")}
            onPress={() => props.onRemove(props.card().id)}
          >
            <Icon name="close" tone="muted-foreground" class="size-3.5" />
          </Button>
        </View>
      </View>

      <If when={hasBody()}>
        <If when={props.card().result.status === "loading"}>
          <View class="px-3 pb-3">
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
          </View>
        </If>

        <If when={props.card().result.status === "streaming"}>
          <View class="gap-1.5 px-3 pb-3">
            <Text testID="quick-translate-status" class="text-xs text-muted-foreground">
              {t("quickTranslate.translating")}
            </Text>
            <View selectable>
              <Text
                testID="quick-translate-result-text"
                class="text-sm leading-relaxed text-card-foreground"
              >
                {(() => {
                  const res = props.card().result;
                  return res.status === "streaming" ? res.text : "";
                })()}
              </Text>
            </View>
          </View>
        </If>

        <If when={props.card().result.status === "error"}>
          <View>
            <View class="gap-1.5 px-3">
              <If
                when={(() => {
                  const res = props.card().result;
                  return res.status === "error" && (res.text ?? "").length > 0;
                })()}
              >
                <View selectable>
                  <Text
                    testID="quick-translate-partial-text"
                    class="text-sm leading-relaxed text-card-foreground"
                  >
                    {(() => {
                      const res = props.card().result;
                      return res.status === "error" ? (res.text ?? "") : "";
                    })()}
                  </Text>
                </View>
              </If>
              <Text testID="quick-translate-error" role="alert" class="text-xs text-destructive">
                {(() => {
                  const res = props.card().result;
                  return res.status === "error" ? res.message : "";
                })()}
              </Text>
            </View>
            <View class="flex-row items-center justify-end px-1.5 pb-1.5 pt-0.5">
              <RetryIconButton
                testID="quick-translate-retry"
                onPress={() => props.onRetry(props.card().id)}
              />
            </View>
          </View>
        </If>

        <If when={props.card().result.status === "success"}>
          <View>
            <View selectable class="px-3">
              <Text
                testID="quick-translate-result-text"
                class="text-sm leading-relaxed text-card-foreground"
              >
                {(() => {
                  const res = props.card().result;
                  return res.status === "success" ? res.text : "";
                })()}
              </Text>
            </View>
            <View class="flex-row items-center justify-between gap-2 px-1.5 pb-1.5 pt-0.5">
              <Button
                testID="quick-translate-copy"
                size="icon-sm"
                variant="ghost"
                tooltip={
                  props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                }
                accessibilityLabel={
                  props.card().copied ? t("quickTranslate.copied") : t("quickTranslate.copy")
                }
                onPress={() => props.onCopy(props.card().id)}
              >
                <Icon
                  name={props.card().copied ? "check" : "copy"}
                  tone={props.card().copied ? "success" : "muted-foreground"}
                  class="size-3.5"
                />
              </Button>
              <RetryIconButton
                testID="quick-translate-retry"
                onPress={() => props.onRetry(props.card().id)}
              />
            </View>
            <If when={props.card().copyError !== null}>
              <View class="px-3 pb-3">
                <Text
                  testID="quick-translate-copy-error"
                  role="alert"
                  class="text-xs text-destructive"
                >
                  {props.card().copyError ?? ""}
                </Text>
              </View>
            </If>
          </View>
        </If>
      </If>
    </Card>
  );
}

/** Compact Quick Translate popup body composed inside the floating window or standalone harness. */
export function QuickTranslatePopup(props: QuickTranslatePopupProps) {
  const isComposing = signal(false);
  const detectionLabel = () => resolveSourceDetectionLabel(props.session.sourceDetection());

  return (
    <View class="gap-2 p-3">
      <If
        when={
          props.session.presetsStatus().kind === "idle" ||
          props.session.presetsStatus().kind === "loading"
        }
      >
        <Card testID="quick-translate-presets-loading" class="gap-1.5 p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.presetsLoading")}</Text>
        </Card>
      </If>

      <If when={props.session.presetsStatus().kind === "error"}>
        <Card
          testID="quick-translate-presets-error"
          class="flex-row items-center justify-between gap-2 border-destructive/40 py-2 pl-3 pr-1.5"
        >
          <Text role="alert" class="min-w-0 flex-1 text-xs text-destructive">
            {(() => {
              const s = props.session.presetsStatus();
              return s.kind === "error" ? s.message : "";
            })()}
          </Text>
          <RetryIconButton
            testID="quick-translate-retry-presets"
            onPress={() => props.session.retryLoadPresets()}
          />
        </Card>
      </If>

      <If
        when={
          props.session.presetsStatus().kind === "ready" &&
          props.session.enabledPresets().length === 0
        }
      >
        <Card testID="quick-translate-no-presets" class="p-3">
          <Text class="text-xs text-muted-foreground">{t("quickTranslate.noEnabledPresets")}</Text>
        </Card>
      </If>

      <Textarea
        testID="quick-translate-source"
        variant="card"
        autoFocus
        submitBehavior="submit"
        value={props.session.sourceText()}
        placeholder={t("quickTranslate.sourcePlaceholder")}
        accessibilityLabel={t("quickTranslate.sourceLabel")}
        inputClass="min-h-10"
        footer={
          <View
            testID="quick-translate-source-toolbar"
            class="min-h-7 flex-row items-center justify-between gap-2"
          >
            <View class="min-w-0 flex-1 pl-1.5">
              <If when={detectionLabel() !== null}>
                <Text
                  testID="quick-translate-source-detection"
                  class="truncate text-xs text-muted-foreground"
                >
                  {detectionLabel() ?? ""}
                </Text>
              </If>
            </View>
            <If when={props.session.sourceText().length > 0}>
              <Button
                testID="quick-translate-clear"
                size="icon-sm"
                variant="ghost"
                tooltip={t("common.clearInput")}
                accessibilityLabel={t("common.clearInput")}
                onPress={() => props.session.handleClearSource()}
              >
                <Icon name="clear" tone="muted-foreground" class="size-3.5" />
              </Button>
            </If>
          </View>
        }
        onChange={(nextText) => props.session.handleSourceChange(nextText)}
        onSubmit={() => {
          if (isComposing()) return;
          props.session.handleSourceSubmit();
        }}
        onCompositionChange={({ composing }) => isComposing.set(composing)}
        ref={(node) => props.onAttachSourceInput?.(node)}
      />

      <If when={props.session.prefsSaveError() !== null}>
        <Text
          testID="quick-translate-preferences-error"
          role="alert"
          class="text-xs text-destructive"
        >
          {props.session.prefsSaveError() ?? ""}
        </Text>
      </If>

      <If when={props.session.cards().length > 0}>
        <View class="gap-2">
          <Each of={props.session.cards()} key={(card) => card.id}>
            {(card) => (
              <PresetCardRow
                card={card}
                presets={props.session.enabledPresets}
                presetItems={props.session.presetItems}
                onOverlayOpenChange={(menuId, open) =>
                  props.session.notifyOverlayOpenChange(menuId, open)
                }
                onSelectPreset={(cardId, presetId) =>
                  props.session.handleSelectCardPreset(cardId, presetId)
                }
                onSelectTemplate={(cardId, templateId) =>
                  props.session.handleSelectCardTemplate(cardId, templateId)
                }
                onToggleCollapse={(cardId) => props.session.handleToggleCollapse(cardId)}
                onRemove={(cardId) => props.session.handleRemoveCard(cardId)}
                onRetry={(id) => props.session.handleRetryCard(id)}
                onCopy={(id) => props.session.handleCopyCard(id)}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
