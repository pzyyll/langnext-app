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
import markdownOutlineIcon from "../../assets/icons/markdown-outline.svg";
import markdownSolidIcon from "../../assets/icons/markdown-solid.svg";
import mdiArrowCollapseIcon from "../../assets/icons/mdi--arrow-collapse.svg";
import mdiCheckIcon from "../../assets/icons/mdi--check.svg";
import mdiChevronDownIcon from "../../assets/icons/mdi--chevron-down.svg";
import mdiChevronRightIcon from "../../assets/icons/mdi--chevron-right.svg";
import mdiChevronUpIcon from "../../assets/icons/mdi--chevron-up.svg";
import mdiCloseCircleIcon from "../../assets/icons/mdi--close-circle.svg";
import mdiCloseIcon from "../../assets/icons/mdi--close.svg";
import mdiContentCopyIcon from "../../assets/icons/mdi--content-copy.svg";
import mdiFlashIcon from "../../assets/icons/mdi--flash.svg";
import mdiFlashOutlineIcon from "../../assets/icons/mdi--flash-outline.svg";
import mdiLanguageMarkdownIcon from "../../assets/icons/mdi--language-markdown.svg";
import mdiLanguageMarkdownOutlineIcon from "../../assets/icons/mdi--language-markdown-outline.svg";
import mdiOcrIcon from "../../assets/icons/mdi--ocr.svg";
import mdiPauseIcon from "../../assets/icons/mdi--pause.svg";
import mdiPencilIcon from "../../assets/icons/mdi--pencil.svg";
import mdiPinOutlineIcon from "../../assets/icons/mdi--pin-outline.svg";
import mdiPinIcon from "../../assets/icons/mdi--pin.svg";
import mdiPlusIcon from "../../assets/icons/mdi--plus.svg";
import mdiRefreshIcon from "../../assets/icons/mdi--refresh.svg";
import mdiStopCircleOutlineIcon from "../../assets/icons/mdi--stop-circle-outline.svg";
import mdiStopIcon from "../../assets/icons/mdi--stop.svg";
import mdiSwapHorizontalIcon from "../../assets/icons/mdi--swap-horizontal.svg";
import mdiTranslateIcon from "../../assets/icons/mdi--translate.svg";
import mdiVolumeHighIcon from "../../assets/icons/mdi--volume-high.svg";
import minusIcon from "../../assets/icons/minus.svg";
import pauseIcon from "../../assets/icons/icon-park-outline--pause.svg";
import picIcon from "../../assets/icons/pic.svg";
import pinSolidIcon from "../../assets/icons/pin-solid.svg";
import pinIcon from "../../assets/icons/pin.svg";
import plusIcon from "../../assets/icons/plus.svg";
import refreshIcon from "../../assets/icons/refresh.svg";
import scanningIcon from "../../assets/icons/icon-park-outline--scanning.svg";
import searchIcon from "../../assets/icons/search.svg";
import speakerOneIcon from "../../assets/icons/icon-park-outline--volume-notice.svg";
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
  "markdown-outline": markdownOutlineIcon,
  "markdown-solid": markdownSolidIcon,
  "mdi:arrow-collapse": mdiArrowCollapseIcon,
  "mdi:check": mdiCheckIcon,
  "mdi:chevron-down": mdiChevronDownIcon,
  "mdi:chevron-right": mdiChevronRightIcon,
  "mdi:chevron-up": mdiChevronUpIcon,
  "mdi:close": mdiCloseIcon,
  "mdi:close-circle": mdiCloseCircleIcon,
  "mdi:content-copy": mdiContentCopyIcon,
  "mdi:flash": mdiFlashIcon,
  "mdi:flash-outline": mdiFlashOutlineIcon,
  "mdi:language-markdown": mdiLanguageMarkdownIcon,
  "mdi:language-markdown-outline": mdiLanguageMarkdownOutlineIcon,
  "mdi:ocr": mdiOcrIcon,
  "mdi:pause": mdiPauseIcon,
  "mdi:pencil": mdiPencilIcon,
  "mdi:pin": mdiPinIcon,
  "mdi:pin-outline": mdiPinOutlineIcon,
  "mdi:plus": mdiPlusIcon,
  "mdi:refresh": mdiRefreshIcon,
  "mdi:stop": mdiStopIcon,
  "mdi:stop-circle-outline": mdiStopCircleOutlineIcon,
  "mdi:swap-horizontal": mdiSwapHorizontalIcon,
  "mdi:translate": mdiTranslateIcon,
  "mdi:volume-high": mdiVolumeHighIcon,
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
