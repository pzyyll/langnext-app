import { Image, token, type ImageAsset } from "nsh";
import alertCircleIcon from "../../assets/icons/alert-circle.svg";
import arrowDownIcon from "../../assets/icons/arrow-down.svg";
import arrowUpIcon from "../../assets/icons/arrow-up.svg";
import checkCircleIcon from "../../assets/icons/check-circle.svg";
import checkIcon from "../../assets/icons/check.svg";
import chevronDownIcon from "../../assets/icons/chevron-down.svg";
import chevronRightIcon from "../../assets/icons/chevron-right.svg";
import chevronUpIcon from "../../assets/icons/chevron-up.svg";
import clearIcon from "../../assets/icons/clear.svg";
import collapseTextInputIcon from "../../assets/icons/icon-park-outline--collapse-text-input.svg";
import closeCircleIcon from "../../assets/icons/close-circle.svg";
import closeIcon from "../../assets/icons/close.svg";
import copyIcon from "../../assets/icons/copy.svg";
import cubeOutlineIcon from "../../assets/icons/cube-outline.svg";
import deeplIcon from "../../assets/icons/deepl.svg";
import deleteIcon from "../../assets/icons/delete.svg";
import editIcon from "../../assets/icons/edit.svg";
import englishIcon from "../../assets/icons/icon-park-outline--english.svg";
import filePdfIcon from "../../assets/icons/file-pdf.svg";
import fileTextIcon from "../../assets/icons/file-text.svg";
import gripVerticalIcon from "../../assets/icons/grip-vertical.svg";
import infoIcon from "../../assets/icons/icon-park-outline--info.svg";
import lightningSolidIcon from "../../assets/icons/lightning-solid.svg";
import lightningIcon from "../../assets/icons/lightning.svg";
import minusIcon from "../../assets/icons/minus.svg";
import pauseIcon from "../../assets/icons/icon-park-outline--pause.svg";
import picIcon from "../../assets/icons/pic.svg";
import pinSolidIcon from "../../assets/icons/pin-solid.svg";
import pinIcon from "../../assets/icons/pin.svg";
import plusIcon from "../../assets/icons/plus.svg";
import refreshIcon from "../../assets/icons/refresh.svg";
import scanningIcon from "../../assets/icons/icon-park-outline--scanning.svg";
import searchIcon from "../../assets/icons/search.svg";
import speakerOneIcon from "../../assets/icons/icon-park-outline--speaker-one.svg";
import switchIcon from "../../assets/icons/switch.svg";
import videoIcon from "../../assets/icons/video.svg";

const ICONS = {
  "alert-circle": alertCircleIcon,
  "arrow-down": arrowDownIcon,
  "arrow-up": arrowUpIcon,
  check: checkIcon,
  "check-circle": checkCircleIcon,
  "chevron-down": chevronDownIcon,
  "chevron-right": chevronRightIcon,
  "chevron-up": chevronUpIcon,
  clear: clearIcon,
  close: closeIcon,
  "close-circle": closeCircleIcon,
  "collapse-text-input": collapseTextInputIcon,
  copy: copyIcon,
  "cube-outline": cubeOutlineIcon,
  deepl: deeplIcon,
  delete: deleteIcon,
  edit: editIcon,
  english: englishIcon,
  "file-pdf": filePdfIcon,
  "file-text": fileTextIcon,
  "grip-vertical": gripVerticalIcon,
  info: infoIcon,
  lightning: lightningIcon,
  "lightning-solid": lightningSolidIcon,
  minus: minusIcon,
  pause: pauseIcon,
  pic: picIcon,
  pin: pinIcon,
  "pin-solid": pinSolidIcon,
  plus: plusIcon,
  refresh: refreshIcon,
  scanning: scanningIcon,
  search: searchIcon,
  "speaker-one": speakerOneIcon,
  switch: switchIcon,
  video: videoIcon,
} satisfies Record<string, ImageAsset>;

/** Supported monochrome icon names sourced from assets/icons. */
export type IconName = keyof typeof ICONS;

/** Theme token names usable as an icon tint color. */
export type IconTone =
  | "foreground"
  | "muted-foreground"
  | "primary-foreground"
  | "secondary-foreground"
  | "accent-foreground"
  | "brand"
  | "destructive"
  | "destructive-foreground"
  | "success"
  | "warning";

interface IconProps {
  name: IconName;
  tone?: IconTone;
  class?: string;
  accessibilityLabel?: string;
}

/** Monochrome theme-tinted SVG icon. */
export function Icon(props: IconProps) {
  return (
    <Image
      src={ICONS[props.name]}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityElementsHidden={!props.accessibilityLabel}
      // Clip intrinsic SVG bounds (48x48 viewBox) so Taffy does not leak phantom overflow into ancestor Scroll views.
      class={`overflow-hidden ${props.class ?? "size-4"}`}
      // Runtime theme token tint keeps monochrome outline icons legible in light and dark modes.
      style={{ tintColor: token(props.tone ?? "foreground") }}
    />
  );
}
