import { mount, Scroll, signal, Text, View } from "nsh";
import { Textarea } from "../textarea";

const source = Array.from(
  { length: 20 },
  (_, i) =>
    `Line ${i + 1}: This source has enough words to wrap at the width of the quick translate window.`,
).join("\n");

function TextareaScrollHarness() {
  const bodyHeight = signal(0);
  const scrollHeight = signal(0);

  return (
    <View class="flex-1">
      <Scroll
        testID="source-scroll"
        class="min-h-0 flex-1"
        onScroll={({ contentSize }) => scrollHeight.set(contentSize.height)}
      >
        <View class="shrink-0 p-3" onLayout={({ bounds }) => bodyHeight.set(bounds.size.height)}>
          <Textarea
            variant="card"
            value={source}
            inputClass="min-h-10"
            footer={<View class="h-7" />}
          />
          <Text>Last preset card</Text>
        </View>
      </Scroll>
      <Text>{`scroll-extent:${scrollHeight()}:${bodyHeight()}`}</Text>
    </View>
  );
}

mount(() => <TextareaScrollHarness />);
