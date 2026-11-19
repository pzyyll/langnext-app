import { signal, type Align } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Menu, MenuItem, MenuSeparator, Submenu } from "../../components/ui/menu";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  getTargetLanguageLabel,
  LANGUAGE_IDS,
  type SourceLanguageId,
  type TargetLanguageId,
} from "../presets/languages";

const SOURCE_LANGUAGE_OPTIONS: readonly SourceLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];
const TARGET_LANGUAGE_OPTIONS: readonly TargetLanguageId[] = [AUTO_LANGUAGE, ...LANGUAGE_IDS];

export interface QuickTranslateLanguageMenuProps {
  sourceLanguage: SourceLanguageId;
  targetLanguage: TargetLanguageId;
  onSelectSourceLanguage: (language: SourceLanguageId) => void;
  onSelectTargetLanguage: (language: TargetLanguageId) => void;
  onOpenChange?: (open: boolean) => void;
  align?: Align;
}

function LanguageOptions<T extends SourceLanguageId | TargetLanguageId>(props: {
  options: readonly T[];
  selected: T;
  testIdPrefix: string;
  formatLabel: (value: T) => string;
  onSelect: (value: T) => void;
}) {
  return (
    <Each of={props.options} key={(id) => id}>
      {(id) => (
        <MenuItem
          testID={`${props.testIdPrefix}-${id()}`}
          role="menuitemradio"
          checked={props.selected === id()}
          label={props.formatLabel(id())}
          onSelect={() => props.onSelect(id())}
        />
      )}
    </Each>
  );
}

/** Title-bar language trigger opening a Menu with cascading Source and Target language Submenus. */
export function QuickTranslateLanguageMenu(props: QuickTranslateLanguageMenuProps) {
  const menuOpen = signal(false);

  const triggerLabel = () =>
    t("quickTranslate.languages", {
      source: getLanguageLabel(props.sourceLanguage),
      target: getTargetLanguageLabel(props.targetLanguage),
    });

  return (
    <Menu
      open={menuOpen()}
      onOpenChange={(open) => {
        menuOpen.set(open);
        props.onOpenChange?.(open);
      }}
      placement="bottom"
      align={props.align ?? "start"}
      trigger={
        <Button
          testID="quick-translate-language-menu"
          variant="ghost"
          size="icon-sm"
          selected={menuOpen()}
          tooltip={triggerLabel()}
          accessibilityLabel={triggerLabel()}
        >
          <Icon
            name="english"
            tone={menuOpen() ? "foreground" : "muted-foreground"}
            class="size-3.5"
          />
        </Button>
      }
    >
      <Submenu
        testID="quick-translate-source-language"
        label={t("quickTranslate.sourceMenuItem", {
          language: getLanguageLabel(props.sourceLanguage),
        })}
      >
        <LanguageOptions
          options={SOURCE_LANGUAGE_OPTIONS}
          selected={props.sourceLanguage}
          testIdPrefix="quick-translate-source-language"
          formatLabel={getLanguageLabel}
          onSelect={props.onSelectSourceLanguage}
        />
      </Submenu>
      <MenuSeparator />
      <Submenu
        testID="quick-translate-target-language"
        label={t("quickTranslate.targetMenuItem", {
          language: getTargetLanguageLabel(props.targetLanguage),
        })}
      >
        <LanguageOptions
          options={TARGET_LANGUAGE_OPTIONS}
          selected={props.targetLanguage}
          testIdPrefix="quick-translate-target-language"
          formatLabel={getTargetLanguageLabel}
          onSelect={props.onSelectTargetLanguage}
        />
      </Submenu>
    </Menu>
  );
}
