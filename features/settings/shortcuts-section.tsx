import { signal, Text, View } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Card, SectionHeading } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
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
  type QuickTranslateShortcutSetting,
} from "./shortcuts";

function QuickTranslateShortcutCard(props: {
  compact: boolean;
  setting: QuickTranslateShortcutSetting;
}) {
  const draft = signal<string | null>(null);
  const error = signal<Awaited<ReturnType<QuickTranslateShortcutSetting["save"]>>>(null);
  const savedValue = () => formatShortcut(props.setting.shortcut());
  const canSave = () =>
    !props.setting.busy() &&
    (props.setting.unavailable() || (draft() !== null && draft() !== savedValue()));
  const save = async () => {
    if (!canSave()) return;
    error.set(null);
    const result = await props.setting.save(draft() ?? savedValue());
    if (result) error.set(result);
    else draft.set(null);
  };
  const alert = () => error() ?? (props.setting.unavailable() ? "inactive" : null);

  return (
    <Card
      testID="settings-quick-translate-shortcut-card"
      class={props.compact ? "gap-3 p-5" : "gap-3 p-6"}
    >
      <SectionHeading title={t("settings.shortcuts.quickTranslate")} />
      <View class="flex-row items-center gap-2">
        <Input
          testID="settings-quick-translate-shortcut"
          accessibilityLabel={t("settings.shortcuts.quickTranslate")}
          class="min-w-0 flex-1"
          value={draft() ?? savedValue()}
          disabled={props.setting.busy()}
          submitBehavior="submit"
          onChange={(value) => {
            draft.set(value);
            error.set(null);
          }}
          onSubmit={() => void save()}
        />
        <Button
          testID="settings-quick-translate-shortcut-save"
          label={t("common.save")}
          variant="primary"
          disabled={!canSave()}
          onPress={() => void save()}
        />
      </View>
      <Text class="text-xs text-muted-foreground">
        {t("settings.shortcuts.format", {
          example: formatShortcut(DEFAULT_QUICK_TRANSLATE_SHORTCUT),
        })}
      </Text>
      <If when={alert() !== null}>
        <Text
          testID="settings-quick-translate-shortcut-error"
          role="alert"
          class="text-sm text-destructive"
        >
          {t(`settings.shortcuts.${alert()}`)}
        </Text>
      </If>
    </Card>
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
        <QuickTranslateShortcutCard
          compact={props.compact}
          setting={props.quickTranslateShortcut!}
        />
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
