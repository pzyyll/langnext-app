// ABOUTME: Parent OCR route providing the service list rail and nested outlet.
// ABOUTME: Delegates list loading and create dialog to the OCR feature layout.
import { createFileRoute } from "@tanstack/react-router";
import { OcrLayout } from "../features/ocr/OcrLayout";

export const Route = createFileRoute("/ocr")({
  component: OcrLayout,
});
