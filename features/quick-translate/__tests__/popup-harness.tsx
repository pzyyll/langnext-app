import { mount, signal, Storage, Text, View, type ClipboardModule } from "nsh";
import { t } from "nsh/i18n";
import { initializeAiModules } from "../../../app/ai-setup";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { loadModelsState } from "../../models/store";
import { createPresetsStore } from "../../presets/store";
import { loadAppearance } from "../../settings/appearance";
import { loadLanguage } from "../../settings/language";
import type {
  TranslateWithPresetInput,
  TranslateWithPresetOptions,
  TranslateWithPresetResult,
} from "../translate";
import { translateWithPreset } from "../translate";
import { QuickTranslatePopup } from "../popup";

export type HarnessMode =
  | "live"
  | "preset-load-error-then-recover"
  | "clipboard-error"
  | "out-of-order"
  | "late-after-close";

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

function PopupHarnessApp(props: { mode: HarnessMode }) {
  const popupOpen = signal(true);
  const sourceText = signal("");
  const autoTranslate = signal(false);
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

  const translateStub = async (
    input: TranslateWithPresetInput,
    options?: TranslateWithPresetOptions,
  ): Promise<TranslateWithPresetResult> => {
    const seq = translateCalls().length + 1;
    translateCalls.set([
      ...translateCalls(),
      `${input.preset.id}:${input.sourceLanguage}->${input.targetLanguage}:${input.sourceText}`,
    ]);
    options?.signal?.addEventListener("abort", () => {
      abortEvents.set([...abortEvents(), `aborted-${seq}`]);
    });

    if (props.mode === "out-of-order") {
      if (seq === 1) {
        firstDeferred = createDeferred<TranslateWithPresetResult>();
        return firstDeferred.promise;
      }
      if (seq === 2) {
        secondDeferred = createDeferred<TranslateWithPresetResult>();
        return secondDeferred.promise;
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
            autoTranslate()
              ? t("quickTranslate.disableAutoTranslate")
              : t("quickTranslate.enableAutoTranslate")
          }
          onPress={() => autoTranslate.set(!autoTranslate())}
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
      </View>

      <If when={popupOpen()}>
        <Card class="overflow-hidden p-0">
          <QuickTranslatePopup
            sourceText={() => sourceText()}
            onSourceTextChange={(text) => sourceText.set(text)}
            autoTranslate={() => autoTranslate()}
            presetsStore={store}
            translate={translateStub}
            clipboard={clipboardStub}
          />
        </Card>
      </If>
    </View>
  );
}

void Promise.all([
  loadAppearance(),
  loadLanguage(),
  loadModelsState(),
  Storage.getItem(POPUP_HARNESS_MODE_KEY),
]).then(([, , , modeRaw]) => {
  const mode: HarnessMode =
    modeRaw === "preset-load-error-then-recover" ||
    modeRaw === "clipboard-error" ||
    modeRaw === "out-of-order" ||
    modeRaw === "late-after-close"
      ? modeRaw
      : "live";
  mount(() => <PopupHarnessApp mode={mode} />);
});
