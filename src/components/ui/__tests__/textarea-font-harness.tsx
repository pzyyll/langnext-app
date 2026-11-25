import { mount, signal, Text, View } from "nsh";
import { LARGEST_FONT_STEP } from "../font-step";
import { Textarea } from "../textarea";

const LONG_TEXT = Array.from(
  { length: 16 },
  (_, index) =>
    `Line ${index + 1}: this source is long enough that the field should leave the display size.`,
).join("\n");

function SteppedFontHarness() {
  const text = signal("Hi");
  const step = signal(-1);
  return (
    <View class="w-full flex-1 p-3">
      <Text>{`step:${step()}`}</Text>
      <Text>{`length:${text().length}`}</Text>
      <Textarea
        testID="stepped-source"
        fontScale="stepped"
        value={text()}
        inputClass="min-h-10"
        onChange={(value) => text.set(value)}
        onFontStep={(next) => step.set(next)}
      />
      <Text testID="use-long-text" onPress={() => text.set(LONG_TEXT)}>
        Use long text
      </Text>
      <Text testID="use-cjk" onPress={() => text.set("\u7a7a".repeat(72))}>
        Use cjk
      </Text>
      <Text testID="clear-text" onPress={() => text.set("")}>
        Clear text
      </Text>
      <Text>{`largest:${LARGEST_FONT_STEP}`}</Text>
    </View>
  );
}

mount(() => <SteppedFontHarness />);
