import { Text, View } from "nsh";

/** Models is a title placeholder until the model list is built. The shell's
 * PageSurface owns the page's scrolling, width and padding. */
export function ModelsPage() {
  return (
    <View class="gap-2">
      <Text role="header" class="text-2xl font-semibold text-foreground">
        Models
      </Text>
    </View>
  );
}
