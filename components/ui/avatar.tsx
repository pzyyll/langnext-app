import { type ImageAsset, type JSX } from "nsh";
import { Avatar as BaseAvatar } from "nsh/base";
import { motion } from "../motion";
import { Icon, type IconName, type IconTone } from "./icon";

export type AvatarSize = "sm" | "md" | "lg";

interface AvatarProps {
  src?: string | ImageAsset | null;
  name?: string | null;
  icon?: IconName;
  iconTone?: IconTone;
  fallback?: JSX.Element;
  size?: AvatarSize;
  accessibilityLabel?: string | null;
  fallbackDelay?: number;
  testID?: string;
  class?: string;
  children?: JSX.Element;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "size-6",
  md: "size-8",
  lg: "size-10",
};

const ICON_SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "size-3",
  md: "size-4",
  lg: "size-5",
};

const FALLBACK_TEXT_CLASSES: Record<AvatarSize, string> = {
  sm: "text-xs font-medium text-muted-foreground",
  md: "text-xs font-medium text-muted-foreground",
  lg: "text-sm font-medium text-muted-foreground",
};

/** Circular avatar built on `nsh/base` Avatar with theme surface, image fit, and icon or initial fallback. */
export function Avatar(props: AvatarProps) {
  const size = () => props.size ?? "md";

  return (
    <BaseAvatar
      testID={props.testID}
      src={props.src}
      name={props.name}
      accessibilityLabel={props.accessibilityLabel}
      fallbackDelay={props.fallbackDelay}
      class={`${SIZE_CLASSES[size()]} shrink-0 overflow-hidden rounded-full bg-muted ${props.class ?? ""}`}
      imageClass={`size-full rounded-full object-cover ${motion.avatarImage}`}
      fallbackClass={`items-center justify-center rounded-full bg-muted ${FALLBACK_TEXT_CLASSES[size()]}`}
      fallback={
        props.fallback ??
        (props.icon !== undefined ? (
          <Icon
            name={props.icon}
            tone={props.iconTone ?? "foreground"}
            class={ICON_SIZE_CLASSES[size()]}
          />
        ) : undefined)
      }
    >
      {props.children}
    </BaseAvatar>
  );
}
