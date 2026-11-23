import { Image, token } from "nsh";
import type { ProviderPresentation } from "./contracts";

interface ProviderMarkProps {
  presentation: ProviderPresentation;
  class?: string;
  accessibilityLabel?: string;
}

/** A provider's mark, drawn in its own brand colors or tinted with the foreground. */
export function ProviderMark(props: ProviderMarkProps) {
  return (
    <Image
      src={props.presentation.icon}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityElementsHidden={!props.accessibilityLabel}
      class={props.class ?? "size-4"}
      // A monochrome mark is a template: the runtime theme token tint keeps it legible in both themes.
      style={
        props.presentation.markStyle === "brand" ? undefined : { tintColor: token("foreground") }
      }
    />
  );
}
