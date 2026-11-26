import { Text, View } from "nsh";
import { TextView } from "nsh/base";

export type TranslationOutputSize = "default" | "sm";

const OUTPUT_CLASS: Record<TranslationOutputSize, string> = {
  default: "text-base leading-relaxed text-card-foreground",
  sm: "text-sm leading-relaxed text-card-foreground",
};

export function translationOutputClass(size: TranslationOutputSize = "default"): string {
  return OUTPUT_CLASS[size];
}

export function TranslationOutput(props: {
  testID: string;
  text: string;
  markdownEnabled: boolean;
  streaming: boolean;
  size?: TranslationOutputSize;
}) {
  const outputClass = () => translationOutputClass(props.size);
  return (
    <If
      when={props.markdownEnabled}
      else={
        <View selectable>
          <Text testID={props.testID} class={outputClass()}>
            {props.text}
          </Text>
        </View>
      }
    >
      <TextView
        testID={props.testID}
        class={outputClass()}
        markdown={props.text}
        options={{ streaming: props.streaming, html: false, math: false }}
        selectable
        links="report"
        renderImage={({ alt }) => <Text>{alt}</Text>}
      />
    </If>
  );
}
