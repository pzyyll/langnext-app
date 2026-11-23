import { Text, View } from "nsh";
import { TextView } from "nsh/base";

const OUTPUT_CLASS = "text-base leading-relaxed text-card-foreground";

export function TranslationOutput(props: {
  testID: string;
  text: string;
  markdownEnabled: boolean;
  streaming: boolean;
}) {
  return (
    <If
      when={props.markdownEnabled}
      else={
        <View selectable>
          <Text testID={props.testID} class={OUTPUT_CLASS}>
            {props.text}
          </Text>
        </View>
      }
    >
      <TextView
        testID={props.testID}
        class={OUTPUT_CLASS}
        markdown={props.text}
        options={{ streaming: props.streaming, html: false, math: false }}
        selectable
        links="report"
        renderImage={({ alt }) => <Text>{alt}</Text>}
      />
    </If>
  );
}
