import { cleanup, signal, Text, View, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Badge } from "../../components/ui/badge";
import { Button, KeyboardButton } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Switch } from "../../components/ui/switch";
import { canUseDoubleCopy } from "../../platform/quick-translate";
import {
  doubleCopyEnabled,
  doubleCopyError,
  selectDoubleCopy,
} from "../quick-translate/preferences";
import {
  DEFAULT_QUICK_TRANSLATE_SHORTCUT,
  formatShortcut,
  recordQuickTranslateShortcut,
  type QuickTranslateShortcutSetting,
} from "./shortcuts";

const RECORDING_CAPTURE_KEYS = ["escape"] as const;

function QuickTranslateShortcutRow(props: { setting: QuickTranslateShortcutSetting }) {
  const error = signal<Awaited<ReturnType<QuickTranslateShortcutSetting["save"]>>>(null);
  const recording = () => props.setting.recording();
  const chord = () => props.setting.shortcut();
  const editLabel = () => t("settings.shortcuts.edit");
  const clearLabel = () => t("settings.shortcuts.clear");
  const resetLabel = () => t("settings.shortcuts.reset");
  let editButton: ViewRef | undefined;

  const cancelRecording = () => {
    props.setting.setRecording(false);
    if (error() === "invalid") error.set(null);
  };
  cleanup(cancelRecording);

  const save = async (value: string | null, restoreFocus = false) => {
    if (props.setting.busy()) return;
    error.set(null);
    props.setting.setRecording(false);
    const result = await props.setting.save(value);
    error.set(result);
    if (restoreFocus && !result) editButton?.focus();
  };
  const alert = () => error() ?? (props.setting.unavailable() ? "inactive" : null);

  return (
    <View class="gap-2">
      <View class="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <SectionHeading title={t("settings.shortcuts.quickTranslate")} class="w-1/3 min-w-32" />
        <View class="flex-1 basis-36 flex-row flex-wrap items-center gap-1">
          <If when={!recording()}>
            <If when={chord() !== null}>
              <Badge testID="settings-quick-translate-shortcut" label={formatShortcut(chord()!)} />
            </If>
            <If when={chord() === null}>
              <Text
                testID="settings-quick-translate-shortcut-unassigned"
                class="text-sm text-muted-foreground"
              >
                {t("settings.shortcuts.unassigned")}
              </Text>
            </If>
          </If>
          <KeyboardButton
            testID="settings-quick-translate-shortcut-record"
            ref={(node) => {
              editButton = node;
            }}
            size={recording() ? "sm" : "icon-sm"}
            variant={recording() ? "outline" : "ghost"}
            label={recording() ? t("settings.shortcuts.pressShortcut") : undefined}
            accessibilityLabel={recording() ? t("settings.shortcuts.pressShortcut") : editLabel()}
            tooltip={recording() ? undefined : editLabel()}
            selected={recording()}
            disabled={props.setting.busy()}
            captureKeys={recording() ? RECORDING_CAPTURE_KEYS : "none"}
            onPress={() => {
              if (recording() || props.setting.busy()) return;
              error.set(null);
              props.setting.setRecording(true);
              editButton?.focus();
            }}
            onBlur={cancelRecording}
            onKeyUp={(event) => {
              // NSH can route Escape down to its navigation command before raw key handlers.
              if (recording() && event.key === "Escape") cancelRecording();
            }}
            onKeyDown={(event) => {
              if (!recording() || event.key === "Escape") return;
              const next = recordQuickTranslateShortcut(event);
              if (next === null) error.set("invalid");
              else if (next !== undefined) void save(next);
            }}
          >
            <If when={!recording()}>
              <Icon name="edit" tone="muted-foreground" />
            </If>
          </KeyboardButton>
          <If when={recording()}>
            {/* Esc cancels from the recorder. Tab must skip this transient pointer action. */}
            <KeyboardButton
              testID="settings-quick-translate-shortcut-cancel"
              focusable={false}
              size="sm"
              variant="ghost"
              label={t("common.cancel")}
              onPress={() => {
                cancelRecording();
                editButton?.focus();
              }}
            />
          </If>
        </View>
        <If when={!recording()}>
          <View class="w-16 shrink-0 flex-row items-center justify-end gap-1">
            <If when={chord() !== null}>
              <Button
                testID="settings-quick-translate-shortcut-clear"
                size="icon-sm"
                variant="ghost"
                accessibilityLabel={clearLabel()}
                tooltip={clearLabel()}
                disabled={props.setting.busy()}
                onPress={() => void save(null, true)}
              >
                <Icon name="delete" tone="muted-foreground" />
              </Button>
            </If>
            <If when={chord() !== DEFAULT_QUICK_TRANSLATE_SHORTCUT}>
              <Button
                testID="settings-quick-translate-shortcut-reset"
                size="icon-sm"
                variant="ghost"
                accessibilityLabel={resetLabel()}
                tooltip={resetLabel()}
                disabled={props.setting.busy()}
                onPress={() => void save(DEFAULT_QUICK_TRANSLATE_SHORTCUT, true)}
              >
                <Icon name="refresh" tone="muted-foreground" />
              </Button>
            </If>
          </View>
        </If>
      </View>
      <If when={recording()}>
        <Text class="text-xs text-muted-foreground">{t("settings.shortcuts.recordingHint")}</Text>
      </If>
      <If when={alert() !== null}>
        <Text
          testID="settings-quick-translate-shortcut-error"
          role="alert"
          class="text-sm text-destructive"
        >
          {t(`settings.shortcuts.${alert()}`)}
        </Text>
      </If>
    </View>
  );
}

export function ShortcutsSection(props: {
  compact: boolean;
  platformOs: string;
  quickTranslateShortcut?: QuickTranslateShortcutSetting;
}) {
  return (
    <>
      <If when={props.quickTranslateShortcut !== undefined}>
        <Card testID="settings-quick-translate-shortcut-card" class={props.compact ? "p-5" : "p-6"}>
          <QuickTranslateShortcutRow setting={props.quickTranslateShortcut!} />
        </Card>
      </If>
      <If when={canUseDoubleCopy(props.platformOs)}>
        <Card testID="settings-double-copy-card" class={props.compact ? "gap-2 p-2" : "gap-2 p-3"}>
          <Switch
            testID="settings-double-copy-switch"
            label={t("settings.doubleCopy.label")}
            checked={doubleCopyEnabled()}
            onChange={(checked) => void selectDoubleCopy(checked)}
          />
          <Text class="px-3 text-xs text-muted-foreground">
            {t("settings.doubleCopy.description")}
          </Text>
          <If when={doubleCopyError() !== null}>
            <Text
              testID="settings-double-copy-error"
              role="alert"
              class="px-3 pb-1 text-sm text-destructive"
            >
              {doubleCopyError()}
            </Text>
          </If>
        </Card>
      </If>
      <If when={!canUseDoubleCopy(props.platformOs)}>
        <Card class={props.compact ? "p-4" : "p-6"}>
          <Text testID="settings-shortcuts-windows-only" class="text-sm text-muted-foreground">
            {t("settings.shortcuts.windowsOnly")}
          </Text>
        </Card>
      </If>
    </>
  );
}
