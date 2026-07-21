// ABOUTME: OCR provider catalog shared by add dialog and service list logos.
// ABOUTME: Phase 1 only offers Baidu and AI; extend this list for later providers.
import type { ComponentType, SVGProps } from "react";
import type { OcrProviderType } from "../../storage/types";
import BaiduIcon from "~icons/svgs/baiducloud";
import AiIcon from "~icons/ri/ai";

type OcrProviderIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type OcrProviderOption = {
  id: OcrProviderType;
  labelKey: "ocr.provider.baidu" | "ocr.provider.ai";
  Icon: OcrProviderIcon;
};

export const OCR_PROVIDER_OPTIONS: readonly OcrProviderOption[] = [
  {
    id: "baidu",
    labelKey: "ocr.provider.baidu",
    Icon: BaiduIcon,
  },
  {
    id: "ai",
    labelKey: "ocr.provider.ai",
    Icon: AiIcon,
  },
] as const;

const OCR_PROVIDER_OPTION_BY_ID: ReadonlyMap<OcrProviderType, OcrProviderOption> = new Map(
  OCR_PROVIDER_OPTIONS.map((option) => [option.id, option]),
);

export function getOcrProviderOption(providerType: OcrProviderType): OcrProviderOption {
  const option = OCR_PROVIDER_OPTION_BY_ID.get(providerType);
  if (!option) {
    throw new Error(`Unknown OCR provider type: ${providerType}`);
  }
  return option;
}
