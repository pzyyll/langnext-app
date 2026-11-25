import { mount, signal, Storage, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { initializeAiModules } from "../../../app/ai-setup";
import { AppShell } from "../../../app/shell";
import { Button } from "../../../components/ui/button";
import { loadSplitRailWidths } from "../../../components/layout/split-rail";
import type { DoubleCopyActivationEvent } from "../../../platform/quick-translate";
import { loadModelsState } from "../../models/store";
import { presetsStore } from "../../presets/store";
import {
  doubleCopyEnabled,
  loadQuickTranslatePreferences,
} from "../../quick-translate/preferences";
import { loadAppearance } from "../appearance";
import { loadLanguage } from "../language";
import { loadTransparency } from "../transparency";

initializeAiModules();

function SettingsDoubleCopyHarness(props: { failMode: "ok" | "throw" }) {
  let listener: ((event: DoubleCopyActivationEvent) => void) | null = null;
  const reads = signal(0);

  return [
    <AppShell
      platformOs="windows"
      quickTranslateOptions={{
        readClipboardText: async () => {
          reads.set(reads() + 1);
          return "Simulated clipboard";
        },
      }}
      doubleCopy={{
        onDoubleCopy(cb) {
          if (props.failMode === "throw") {
            throw new Error("raw input busy");
          }
          listener = cb;
          return () => {
            if (listener === cb) {
              listener = null;
            }
          };
        },
      }}
    />,
    <Window id="harness" focusable={false} activate={false}>
      <View class="flex-row items-center gap-2 px-4 py-1">
        <Button
          testID="dc-harness-trigger"
          label="Trigger DC"
          size="sm"
          onPress={() => listener?.({ hasValidCopy: true })}
        />
        <Text testID="dc-harness-state">{`active=${doubleCopyEnabled()}|reads=${reads()}`}</Text>
      </View>
    </Window>,
  ];
}

void Promise.all([
  loadAppearance(),
  loadLanguage(),
  loadTransparency(),
  loadQuickTranslatePreferences(),
  loadModelsState(),
  presetsStore.load(),
  loadSplitRailWidths(),
  Storage.getItem("__test.dc.failMode"),
]).then(([, , , , , , , failMode]) => {
  mount(() => <SettingsDoubleCopyHarness failMode={failMode === "throw" ? "throw" : "ok"} />);
});
