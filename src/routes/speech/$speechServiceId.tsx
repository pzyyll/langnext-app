// ABOUTME: Dynamic Speech child route for one selected service instance.
// ABOUTME: Reads the service ID from the URL and renders its configuration editor.
import { createFileRoute } from "@tanstack/react-router";
import { SpeechServiceEditor } from "../../features/speech/SpeechServiceEditor";

export const Route = createFileRoute("/speech/$speechServiceId")({
  component: SpeechServicePage,
});

function SpeechServicePage() {
  const { speechServiceId } = Route.useParams();
  return <SpeechServiceEditor speechServiceId={speechServiceId} />;
}
