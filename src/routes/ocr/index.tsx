// ABOUTME: Empty OCR child route shown before a service is selected.
// ABOUTME: Prompts the user to select or create an OCR service.
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/ocr/")({
  component: OcrEmptyPage,
});

function OcrEmptyPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 p-8">
      <p className="max-w-md text-body-md text-neutral">{t("ocr.emptyPage")}</p>
    </div>
  );
}
