import { Text, View } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { Switch } from "../../components/ui/switch";
import { appearance, appearanceError, selectAppearance, type Appearance } from "./appearance";
import { selectTransparency, transparency, transparencyError } from "./transparency";

interface ThemeOptionProps {
  value: Appearance;
  label: string;
}

function ThemeOption(props: ThemeOptionProps) {
  return (
    <Radio
      testID={`theme-${props.value}`}
      checked={appearance() === props.value}
      onChange={() => void selectAppearance(props.value)}
      class="flex-1 rounded-lg border border-border p-4 checked:border-primary checked:bg-accent hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Text class="text-sm font-medium text-card-foreground">{props.label}</Text>
    </Radio>
  );
}

/** Settings owns its controls only; the shell's PageSurface owns the page's
 * scrolling, width and padding. */
export function SettingsPage() {
  return (
    <>
      <Text role="header" class="text-2xl font-semibold text-foreground">
        Settings
      </Text>
      <View class="gap-5 rounded-xl border border-border bg-card p-6">
        <Text role="header" class="text-base font-semibold text-card-foreground">
          Appearance
        </Text>
        <RadioGroup class="flex-row gap-3">
          <ThemeOption value="light" label="Light" />
          <ThemeOption value="dark" label="Dark" />
          <ThemeOption value="system" label="System" />
        </RadioGroup>
        <If when={appearanceError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {appearanceError()}
          </Text>
        </If>
        <Switch
          label="Transparent title bar and sidebar"
          checked={transparency()}
          onChange={(checked) => void selectTransparency(checked)}
        />
        <If when={transparencyError() !== null}>
          <Text role="alert" class="text-sm text-destructive">
            {transparencyError()}
          </Text>
        </If>
      </View>
    </>
  );
}
