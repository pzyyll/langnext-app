import { Text, View } from "nsh";

/** A starter Home screen with clearly labelled example content. The shell's
 * PageSurface owns the page's scrolling, width and padding. */
export function HomePage() {
  return (
    <>
      <View class="gap-2">
        <Text role="header" class="text-2xl font-semibold text-foreground">
          Home
        </Text>
        <Text class="text-sm text-muted-foreground">Welcome to My Translator.</Text>
      </View>
      <View class="gap-6 rounded-xl border border-border bg-card p-6">
        <View class="gap-2">
          <Text role="header" class="text-base font-semibold text-card-foreground">
            Translation example
          </Text>
          <Text class="text-sm text-muted-foreground">
            Sample content only. No translation service is connected yet.
          </Text>
        </View>
        <View class="gap-2">
          <Text class="text-xs font-medium text-muted-foreground">English</Text>
          <Text class="text-base text-card-foreground">
            A new language opens a new window on the world.
          </Text>
        </View>
        <View class="gap-2 border-t border-border pt-6">
          <Text class="text-xs font-medium text-muted-foreground">简体中文</Text>
          <Text class="text-base text-card-foreground">一门新的语言，为你打开一扇看世界的窗。</Text>
        </View>
      </View>
      <View class="gap-2">
        <Text role="header" class="text-base font-semibold text-foreground">
          Your workspace
        </Text>
        <Text class="text-sm text-muted-foreground">
          Use Settings in the sidebar to choose a light or dark theme, or follow your system.
        </Text>
      </View>
    </>
  );
}
