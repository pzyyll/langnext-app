import { cleanup, platform, Scroll, signal, Text, View, type Accessor, type InputRef } from "nsh";
import {
  Application,
  displays,
  GlobalShortcut,
  titleBar,
  Window,
  type DisplayId,
  type GlobalShortcutModule,
  type WindowRef,
} from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Select, type SelectItem } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import {
  AUTO_LANGUAGE,
  getLanguageLabel,
  LANGUAGE_IDS,
  type SourceLanguageId,
} from "../features/presets/languages";

export const QUICK_TRANSLATE_WINDOW_ID = "quick-translate";
export const QUICK_TRANSLATE_SHORTCUT = "ctrl+shift+t";

const POPUP_DEFAULT_SIZE = { width: 420, height: 360 } as const;
const POPUP_MIN_SIZE = { width: 340, height: 280 } as const;

export type QuickTranslateShortcutBinding = Pick<GlobalShortcutModule, "register" | "unregister">;

export interface QuickTranslateController {
  isOpen: Accessor<boolean>;
  isPinned: Accessor<boolean>;
  openingDisplay: Accessor<DisplayId | undefined>;
  sourceText: Accessor<string>;
  open: () => void;
  close: () => void;
  setPinned: (pinned: boolean) => void;
  togglePinned: () => void;
  setSourceText: (text: string) => void;
  setMenuOpen: (menuId: string, open: boolean) => void;
  hasOpenOverlay: () => boolean;
  attachWindow: (win: WindowRef | null) => void;
  attachSourceInput: (input: InputRef | null) => void;
  setOnCloseCleanup: (callback: (() => void) | null) => void;
}

/** Only Windows registers the Stage 1 global shortcut. */
export function canRegisterGlobalQuickTranslateShortcut(os: string): boolean {
  return os === "windows";
}

function resolveMainWindowDisplay(): DisplayId | undefined {
  const mainDisplay = Window.get("main")?.state()?.display;
  if (mainDisplay) {
    return mainDisplay.id;
  }
  const allDisplays = displays();
  return allDisplays.find((entry) => entry.primary)?.id ?? allDisplays[0]?.id;
}

/** Owns Quick Translate window open/focus reuse, pin state, overlay tracking, and single-path cleanup. */
export function createQuickTranslateController(): QuickTranslateController {
  const openSignal = signal(false);
  const pinnedSignal = signal(false);
  const openingDisplaySignal = signal<DisplayId | undefined>(undefined);
  const sourceSignal = signal("");
  const openMenusSignal = signal<Record<string, boolean>>({});
  let windowRef: WindowRef | null = null;
  let sourceInputRef: InputRef | null = null;
  let closeCleanup: (() => void) | null = null;

  const focusWindowAndInput = () => {
    (windowRef ?? Window.get(QUICK_TRANSLATE_WINDOW_ID))?.focus();
    sourceInputRef?.focus();
  };

  const close = () => {
    const hadState =
      openSignal() ||
      pinnedSignal() ||
      sourceSignal() !== "" ||
      Object.keys(openMenusSignal()).length > 0;
    if (!hadState && windowRef === null) {
      return;
    }
    openSignal.set(false);
    pinnedSignal.set(false);
    sourceSignal.set("");
    openMenusSignal.set({});
    windowRef = null;
    sourceInputRef = null;
    closeCleanup?.();
  };

  const open = () => {
    if (openSignal()) {
      focusWindowAndInput();
      return;
    }
    openingDisplaySignal.set(resolveMainWindowDisplay());
    openSignal.set(true);
  };

  return {
    isOpen: () => openSignal(),
    isPinned: () => pinnedSignal(),
    openingDisplay: () => openingDisplaySignal(),
    sourceText: () => sourceSignal(),
    open,
    close,
    setPinned: (pinned: boolean) => pinnedSignal.set(pinned),
    togglePinned: () => pinnedSignal.set(!pinnedSignal()),
    setSourceText: (text: string) => sourceSignal.set(text),
    setMenuOpen: (menuId: string, openMenu: boolean) => {
      const current = openMenusSignal();
      if (openMenu) {
        if (current[menuId]) return;
        openMenusSignal.set({ ...current, [menuId]: true });
        return;
      }
      if (!current[menuId]) return;
      const next = { ...current };
      delete next[menuId];
      openMenusSignal.set(next);
    },
    hasOpenOverlay: () => Object.values(openMenusSignal()).some(Boolean),
    attachWindow: (win: WindowRef | null) => {
      windowRef = win;
    },
    attachSourceInput: (input: InputRef | null) => {
      sourceInputRef = input;
      input?.focus();
    },
    setOnCloseCleanup: (callback: (() => void) | null) => {
      closeCleanup = callback;
    },
  };
}

/** Registers `ctrl+shift+t` once on Windows and unregisters cleanly on shell disposal or quit. */
export function registerQuickTranslateShortcut(
  controller: QuickTranslateController,
  binding: QuickTranslateShortcutBinding = GlobalShortcut,
  currentOs: string = platform.os,
): () => void {
  if (!canRegisterGlobalQuickTranslateShortcut(currentOs)) {
    return () => {};
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stopQuitListener();
    try {
      binding.unregister(QUICK_TRANSLATE_SHORTCUT);
    } catch {
      // Ignore cleanup failures while tearing down the shell.
    }
  };

  const stopQuitListener = Application.on("quit", release);
  cleanup(release);

  void (async () => {
    try {
      const accepted = await binding.register(QUICK_TRANSLATE_SHORTCUT, () => controller.open());
      if (!released && !accepted) {
        toast.warning(t("quickTranslate.shortcutUnavailable"));
      }
    } catch {
      if (!released) {
        toast.warning(t("quickTranslate.shortcutUnavailable"));
      }
    }
  })();

  return release;
}

function buildSourceLanguageItems(): SelectItem[] {
  return [
    { value: AUTO_LANGUAGE, title: getLanguageLabel(AUTO_LANGUAGE) },
    ...LANGUAGE_IDS.map((id) => ({ value: id, title: getLanguageLabel(id) })),
  ];
}

/** Renders popup contents inside `<Window>` so `titleBar()` reads this window's caption area. */
function QuickTranslateWindowBody(props: { controller: QuickTranslateController }) {
  const sourceLanguage = signal<SourceLanguageId>(AUTO_LANGUAGE);
  const caption = titleBar();

  return (
    <View class="flex-1 bg-background text-foreground">
      <View
        testID="quick-translate-header"
        desktop={{ windowDrag: true }}
        class="shrink-0 flex-row items-center justify-between gap-2 border-b border-border bg-background pl-3"
        // Runtime platform titleBar() insets determine height and caption-button clearance.
        style={{
          height: Math.max(38, caption.height),
          paddingRight: caption.right + 8,
        }}
      >
        <Text class="text-xs font-medium text-foreground">{t("quickTranslate.title")}</Text>
        <View class="flex-row items-center gap-1">
          <Button
            testID="quick-translate-pin"
            variant="ghost"
            size="icon-sm"
            selected={props.controller.isPinned()}
            class={props.controller.isPinned() ? "bg-accent" : undefined}
            tooltip={
              props.controller.isPinned() ? t("quickTranslate.unpin") : t("quickTranslate.pin")
            }
            accessibilityLabel={
              props.controller.isPinned() ? t("quickTranslate.unpin") : t("quickTranslate.pin")
            }
            onPress={() => props.controller.togglePinned()}
          >
            <Icon
              name={props.controller.isPinned() ? "pin-solid" : "pin"}
              tone={props.controller.isPinned() ? "foreground" : "muted-foreground"}
              class="size-3.5"
            />
          </Button>
          <If when={titleBar().right === 0}>
            <Button
              testID="quick-translate-close"
              variant="ghost"
              size="icon-sm"
              tooltip={t("quickTranslate.close")}
              accessibilityLabel={t("quickTranslate.close")}
              onPress={() => props.controller.close()}
            >
              <Icon name="close" tone="muted-foreground" class="size-3.5" />
            </Button>
          </If>
        </View>
      </View>
      <Scroll class="min-h-0 flex-1">
        <View class="gap-3 p-3">
          <View class="flex-row items-center gap-2">
            <Select
              testID="quick-translate-source-language"
              size="sm"
              items={buildSourceLanguageItems()}
              value={sourceLanguage()}
              accessibilityLabel={t("presets.fields.sourceLanguage")}
              onOpenChange={(open) => props.controller.setMenuOpen("source-language", open)}
              onChange={(value) => {
                if (value) {
                  sourceLanguage.set(value as SourceLanguageId);
                }
              }}
            />
          </View>
          <Textarea
            testID="quick-translate-source"
            value={props.controller.sourceText()}
            placeholder={t("quickTranslate.sourcePlaceholder")}
            accessibilityLabel={t("quickTranslate.sourceLabel")}
            onChange={(value) => props.controller.setSourceText(value)}
            ref={(node) => props.controller.attachSourceInput(node)}
          />
        </View>
      </Scroll>
    </View>
  );
}

/** Floating Stage 1 Quick Translate window controlled by the app shell. */
export function QuickTranslateWindow(props: { controller: QuickTranslateController }) {
  return (
    <Window
      id={QUICK_TRANSLATE_WINDOW_ID}
      open={props.controller.isOpen()}
      title={t("quickTranslate.title")}
      kind="panel"
      titleBar={{ style: "hidden", height: 38 }}
      level="floating"
      taskbar={false}
      resizable={true}
      minimizable={false}
      maximizable={false}
      closable={true}
      focusable={true}
      activate={true}
      backdrop="none"
      shadow={true}
      defaultSize={POPUP_DEFAULT_SIZE}
      minSize={POPUP_MIN_SIZE}
      display={props.controller.openingDisplay()}
      defaultPosition="center"
      closeOnPress={true}
      closeOnBlur={!props.controller.isPinned()}
      closeOnEscape={!props.controller.hasOpenOverlay()}
      onOpenChange={({ open }) => {
        if (!open) {
          props.controller.close();
        }
      }}
      ref={(node) => props.controller.attachWindow(node)}
    >
      <QuickTranslateWindowBody controller={props.controller} />
    </Window>
  );
}
