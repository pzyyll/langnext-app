import { Scroll, Text, View } from "nsh";

/** Models is a title placeholder until the model list is built. */
export function ModelsPage() {
  return (
    <Scroll testID="models-page" class="min-w-0 flex-1">
      <View class="w-full max-w-4xl gap-8 p-8">
        <View class="gap-2">
          <Text role="header" class="text-2xl font-semibold text-foreground">
            Models
          </Text>
        </View>
      </View>
    </Scroll>
  );
}
