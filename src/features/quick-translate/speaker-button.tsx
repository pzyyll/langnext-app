import { Button } from "../../components/ui/button";
import { Icon, type IconName } from "../../components/ui/icon";

export interface SpeakControlState {
  disabled: boolean;
  tooltip?: string;
  label: string;
  icon: IconName;
  busy: boolean;
}

/** Shared TTS playback/cancel icon button used across source, cards, and dictionary drawer. */
export function SpeakerButton(props: {
  testID: string;
  control: SpeakControlState;
  onPress: () => void;
}) {
  return (
    <Button
      testID={props.testID}
      size="icon-xs"
      variant="ghost"
      disabled={props.control.disabled}
      tooltip={props.control.tooltip}
      accessibilityLabel={props.control.label}
      onPress={() => props.onPress()}
    >
      <Icon name={props.control.icon} tone="muted-foreground" class="size-3.5" />
    </Button>
  );
}
