import { colorScheme, Scroll, Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";

interface ThemeOptionProps {
  value: Appearance;
  label: string;
  description: string;
}

function ThemeOption(props: ThemeOptionProps) {
  return (
    <Radio
      testID={`theme-${props.value}`}
      checked={appearance() === props.value}
      onChange={() => void selectAppearance(props.value)}
      class="flex-1 gap-2 rounded-lg border border-border p-4 checked:border-primary checked:bg-accent hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Text class="text-sm font-medium text-card-foreground">{props.label}</Text>
      <Text class="text-xs text-muted-foreground">{props.description}</Text>
    </Radio>
  );
}

export function SettingsPage() {
  return (
    <Scroll class="min-w-0 flex-1">
      <View class="w-full max-w-4xl gap-8 p-8">
        <View class="gap-2">
          <Text role="header" class="text-2xl font-semibold text-foreground">
            Settings
          </Text>
          <Text class="text-sm text-muted-foreground">Make My Translator feel like yours.</Text>
        </View>
        <View class="gap-5 rounded-xl border border-border bg-card p-6">
          <View class="gap-2">
            <Text role="header" class="text-base font-semibold text-card-foreground">
              Appearance
            </Text>
            <Text class="text-sm text-muted-foreground">
              Choose a theme, or follow your system.
            </Text>
          </View>
          <RadioGroup class="flex-row gap-3">
            <ThemeOption value="light" label="Light" description="A bright workspace." />
            <ThemeOption value="dark" label="Dark" description="A darker workspace." />
            <ThemeOption value="system" label="System" description="Match your device." />
          </RadioGroup>
          <Text testID="theme-status" class="text-xs text-muted-foreground">
            {appearance() === "system"
              ? `Following system · ${colorScheme()}`
              : `${appearance() === "light" ? "Light" : "Dark"} theme`}
          </Text>
          <If when={appearanceError() !== null}>
            <Text role="alert" class="text-sm text-destructive">
              {appearanceError()}
            </Text>
          </If>
        </View>
      </View>
    </Scroll>
  );
}
