// ABOUTME: Creatable OCR provider catalog for the Add OCR service dialog.
// ABOUTME: Phase 1 only offers Baidu and AI; extend this list for later providers.
import type { OcrProviderType } from "../../storage/types";

export type OcrProviderOption = {
  id: OcrProviderType;
  labelKey: "ocr.provider.baidu" | "ocr.provider.ai";
  descriptionKey: "ocr.provider.baiduDescription" | "ocr.provider.aiDescription";
};

export const OCR_PROVIDER_OPTIONS: readonly OcrProviderOption[] = [
  {
    id: "baidu",
    labelKey: "ocr.provider.baidu",
    descriptionKey: "ocr.provider.baiduDescription",
  },
  {
    id: "ai",
    labelKey: "ocr.provider.ai",
    descriptionKey: "ocr.provider.aiDescription",
  },
] as const;
