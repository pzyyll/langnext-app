import { mount, signal, Text, View } from "nsh";
import { initializeAiModules } from "../../../app/ai-setup";
import { loadModelsState } from "../../models/store";
import { PRESETS_STORAGE_KEY, presetsStore } from "../../presets/store";
import { loadLanguage } from "../../settings/language";
import { translateWithPreset } from "../translate";

initializeAiModules();

function TranslateHarnessApp() {
  const status = signal("running");
  const resultJson = signal("");

  void (async () => {
    try {
      await loadLanguage();
      await loadModelsState();
      await presetsStore.load();

      const preset = presetsStore.records()[0];
      if (!preset) {
        resultJson.set(JSON.stringify({ ok: false, cancelled: false, error: "missing preset" }));
        status.set("done");
        return;
      }

      // The caller supplies the resolved pair; presets never store languages.
      const outcome = await translateWithPreset({
        preset,
        sourceText: "Hello {{target_language}}",
        sourceLanguage: "en",
        targetLanguage: "zh",
      });

      resultJson.set(JSON.stringify(outcome));
      status.set("done");
    } catch (error) {
      resultJson.set(
        JSON.stringify({
          ok: false,
          cancelled: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      status.set("error");
    }
  })();

  return (
    <View class="p-4">
      <Text testID="qt-status">{status()}</Text>
      <Text testID="qt-result">{resultJson()}</Text>
      <Text testID="qt-presets-key">{PRESETS_STORAGE_KEY}</Text>
    </View>
  );
}

mount(TranslateHarnessApp);
