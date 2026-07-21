// ABOUTME: Dynamic OCR child route for one selected service instance.
// ABOUTME: Reads the service ID from the URL and renders its configuration editor.
import { createFileRoute } from "@tanstack/react-router";
import { OcrServiceEditor } from "../../features/ocr/OcrServiceEditor";

export const Route = createFileRoute("/ocr/$ocrServiceId")({
  component: OcrServicePage,
});

function OcrServicePage() {
  const { ocrServiceId } = Route.useParams();
  return <OcrServiceEditor ocrServiceId={ocrServiceId} />;
}
