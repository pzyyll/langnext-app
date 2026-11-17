import { Image, token, type ImageAsset } from "nsh";

interface ProviderMarkProps {
  icon: ImageAsset;
  class?: string;
  accessibilityLabel?: string;
}

/** Monochrome provider mark rendered from a contributed asset. */
export function ProviderMark(props: ProviderMarkProps) {
  return (
    <Image
      src={props.icon}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityElementsHidden={!props.accessibilityLabel}
      class={props.class ?? "size-4"}
      // Runtime theme token tint keeps contributed monochrome marks legible in both themes.
      style={{ tintColor: token("foreground") }}
    />
  );
}
