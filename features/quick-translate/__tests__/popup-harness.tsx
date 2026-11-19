import { mount, Scroll, signal, Storage, Text, View, type ClipboardModule } from "nsh";
import { t } from "nsh/i18n";
import { initializeAiModules } from "../../../app/ai-setup";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { loadModelsState } from "../../models/store";
import { createPresetsStore } from "../../presets/store";
import { loadAppearance } from "../../settings/appearance";
import { loadLanguage } from "../../settings/language";
import {
  createQuickTranslatePreferencesStore,
  type QuickTranslatePreferencesStore,
} from "../preferences";
import type {
  TranslateWithPresetInput,
  TranslateWithPresetOptions,
  TranslateWithPresetResult,
} from "../translate";
import { translateWithPreset } from "../translate";
import { QuickTranslateLanguageMenu } from "../language-menu";
import { QuickTranslatePopup } from "../popup";
import { createQuickTranslateSession, type QuickTranslateSessionOptions } from "../session";

export type HarnessMode =
  | "live"
  | "preset-load-error-then-recover"
  | "clipboard-error"
  | "out-of-order"
  | "late-after-close"
  | "multi-card";

export const POPUP_HARNESS_MODE_KEY = "__test.qt.popupMode";

initializeAiModules();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function PopupSessionView(props: QuickTranslateSessionOptions) {
  const session = createQuickTranslateSession(props);
  return (
    <Card class="min-h-0 flex-1 overflow-hidden p-0">
      <View class="shrink-0 flex-row items-center justify-between border-b border-border px-3 py-1.5">
        <Text class="text-xs font-medium text-foreground">{t("quickTranslate.title")}</Text>
        <QuickTranslateLanguageMenu
          sourceLanguage={session.sourceLanguage()}
          targetLanguage={session.targetLanguage()}
          onSelectSourceLanguage={(language) => session.handleSourceLanguageChange(language)}
          onSelectTargetLanguage={(language) => session.handleTargetLanguageChange(language)}
          onOpenChange={(open) => session.notifyOverlayOpenChange("language-menu", open)}
        />
      </View>
      <Scroll class="min-h-0 flex-1">
        <QuickTranslatePopup session={session} />
      </Scroll>
    </Card>
  );
}

function PopupHarnessApp(props: {
  mode: HarnessMode;
  prefs: QuickTranslatePreferencesStore;
  onToggleWriteFail: () => void;
}) {
  const popupOpen = signal(true);
  const sourceText = signal("");
  const presetsErrorFail = signal(props.mode === "preset-load-error-then-recover");
  const translateCalls = signal<string[]>([]);
  const abortEvents = signal<string[]>([]);

  const customStorage = {
    async getItem(key: string) {
      if (presetsErrorFail()) {
        throw new Error("Presets disk failure");
      }
      return Storage.getItem(key);
    },
    setItem: (key: string, value: string) => Storage.setItem(key, value),
  };

  const store = createPresetsStore(customStorage, () => []);
  void store.load();

  let firstDeferred: Deferred<TranslateWithPresetResult> | null = null;
  let secondDeferred: Deferred<TranslateWithPresetResult> | null = null;
  let thirdDeferred: Deferred<TranslateWithPresetResult> | null = null;
  let fourthDeferred: Deferred<TranslateWithPresetResult> | null = null;
  let fifthDeferred: Deferred<TranslateWithPresetResult> | null = null;

  const translateStub = async (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ): Promise<TranslateWithPresetResult> => {
    const seq = translateCalls().length + 1;
    translateCalls.set([
      ...translateCalls(),
      `${input.preset.id}:${input.templateId ?? "default"}:${input.sourceLanguage}->${input.targetLanguage}:${input.sourceText}`,
    ]);
    options?.signal?.addEventListener("abort", () => {
      abortEvents.set([...abortEvents(), `aborted-${seq}`]);
    });

    if (props.mode === "out-of-order" || props.mode === "multi-card") {
      if (seq === 1) {
        firstDeferred = createDeferred<TranslateWithPresetResult>();
        return firstDeferred.promise;
      }
      if (seq === 2) {
        secondDeferred = createDeferred<TranslateWithPresetResult>();
        return secondDeferred.promise;
      }
      if (seq === 3) {
        thirdDeferred = createDeferred<TranslateWithPresetResult>();
        return thirdDeferred.promise;
      }
      if (seq === 4) {
        fourthDeferred = createDeferred<TranslateWithPresetResult>();
        return fourthDeferred.promise;
      }
      if (seq === 5) {
        fifthDeferred = createDeferred<TranslateWithPresetResult>();
        return fifthDeferred.promise;
      }
    }

    if (props.mode === "late-after-close") {
      firstDeferred = createDeferred<TranslateWithPresetResult>();
      return firstDeferred.promise;
    }

    return translateWithPreset(input, options);
  };

  const clipboardStub: Pick<ClipboardModule, "writeText"> | undefined =
    props.mode === "clipboard-error"
      ? {
          async writeText() {
            throw new Error("Clipboard locked");
          },
        }
      : undefined;

  return (
    <View class="flex-1 bg-background p-3 text-foreground">
      <View class="mb-2 flex-row flex-wrap items-center gap-2">
        <Button
          testID="harness-toggle-auto"
          size="xs"
          variant="outline"
          label={
            props.prefs.autoTranslate()
              ? t("quickTranslate.disableAutoTranslate")
              : t("quickTranslate.enableAutoTranslate")
          }
          onPress={() =>
            void props.prefs.savePopupState({ autoTranslate: !props.prefs.autoTranslate() })
          }
        />
        <Button
          testID="harness-toggle-open"
          size="xs"
          variant="outline"
          label={popupOpen() ? "Close Harness Popup" : "Open Harness Popup"}
          onPress={() => {
            if (popupOpen()) {
              popupOpen.set(false);
              sourceText.set("");
            } else {
              popupOpen.set(true);
            }
          }}
        />
        <If when={props.mode === "preset-load-error-then-recover"}>
          <Button
            testID="harness-fix-storage"
            size="xs"
            variant="outline"
            label="Fix Storage"
            onPress={() => presetsErrorFail.set(false)}
          />
        </If>
        <If when={props.mode === "out-of-order"}>
          <View class="flex-row gap-1">
            <Button
              testID="harness-resolve-second"
              size="xs"
              variant="outline"
              label="Resolve 2"
              onPress={() =>
                secondDeferred?.resolve({
                  ok: true,
                  text: "Result 2",
                  modelId: "m-1",
                  templateId: "tpl-1",
                })
              }
            />
            <Button
              testID="harness-resolve-first"
              size="xs"
              variant="outline"
              label="Resolve 1"
              onPress={() =>
                firstDeferred?.resolve({
                  ok: true,
                  text: "Result 1",
                  modelId: "m-1",
                  templateId: "tpl-1",
                })
              }
            />
          </View>
        </If>
        <If when={props.mode === "multi-card"}>
          <View class="flex-row flex-wrap gap-1">
            <Button
              testID="harness-fail-first"
              size="xs"
              variant="outline"
              label="Fail 1"
              onPress={() =>
                firstDeferred?.resolve({
                  ok: false,
                  cancelled: false,
                  error: "Request timed out for card 1",
                })
              }
            />
            <Button
              testID="harness-resolve-second"
              size="xs"
              variant="outline"
              label="Resolve 2"
              onPress={() =>
                secondDeferred?.resolve({
                  ok: true,
                  text: "Card 2 Formal Result",
                  modelId: "m-1",
                  templateId: "tpl-2",
                })
              }
            />
            <Button
              testID="harness-resolve-third"
              size="xs"
              variant="outline"
              label="Resolve 3"
              onPress={() =>
                thirdDeferred?.resolve({
                  ok: true,
                  text: "Card 1 Retry Result",
                  modelId: "m-1",
                  templateId: "tpl-1",
                })
              }
            />
            <Button
              testID="harness-resolve-fourth"
              size="xs"
              variant="outline"
              label="Resolve 4"
              onPress={() =>
                fourthDeferred?.resolve({
                  ok: true,
                  text: "Stale Card 2 Late Result",
                  modelId: "m-1",
                  templateId: "tpl-2",
                })
              }
            />
            <Button
              testID="harness-resolve-fifth"
              size="xs"
              variant="outline"
              label="Resolve 5"
              onPress={() =>
                fifthDeferred?.resolve({
                  ok: true,
                  text: "Card 1 Expanded Result",
                  modelId: "m-1",
                  templateId: "tpl-1",
                })
              }
            />
          </View>
        </If>
        <If when={props.mode === "late-after-close"}>
          <Button
            testID="harness-resolve-late"
            size="xs"
            variant="outline"
            label="Resolve Late"
            onPress={() =>
              firstDeferred?.resolve({
                ok: true,
                text: "Stale Late Result",
                modelId: "m-1",
                templateId: "tpl-1",
              })
            }
          />
        </If>
        <Text testID="harness-popup-stats">{`calls=${translateCalls().length}|aborts=${abortEvents().join(",")}`}</Text>
        <Button
          testID="harness-toggle-prefs-write-fail"
          size="xs"
          variant="outline"
          label="Toggle Prefs Write Fail"
          onPress={() => props.onToggleWriteFail()}
        />
      </View>

      <If when={popupOpen()}>
        <PopupSessionView
          sourceText={() => sourceText()}
          onSourceTextChange={(text) => sourceText.set(text)}
          autoTranslate={() => props.prefs.autoTranslate()}
          presetsStore={store}
          preferences={props.prefs}
          translate={translateStub}
          clipboard={clipboardStub}
        />
      </If>
    </View>
  );
}

void Promise.all([
  loadAppearance(),
  loadLanguage(),
  loadModelsState(),
  Storage.getItem(POPUP_HARNESS_MODE_KEY),
]).then(async ([, , , modeRaw]) => {
  const mode: HarnessMode =
    modeRaw === "preset-load-error-then-recover" ||
    modeRaw === "clipboard-error" ||
    modeRaw === "out-of-order" ||
    modeRaw === "late-after-close" ||
    modeRaw === "multi-card"
      ? modeRaw
      : "live";

  let simulateWriteFailure = false;
  const prefs = createQuickTranslatePreferencesStore({
    getItem: (key) => Storage.getItem(key),
    setItem: (key, value) => {
      if (simulateWriteFailure) {
        return Promise.reject(new Error("Simulated prefs write failure"));
      }
      return Storage.setItem(key, value);
    },
  });
  await prefs.load();
  mount(() => (
    <PopupHarnessApp
      mode={mode}
      prefs={prefs}
      onToggleWriteFail={() => {
        simulateWriteFailure = !simulateWriteFailure;
      }}
    />
  ));
});
