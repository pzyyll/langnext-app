// ABOUTME: Parent Speech route providing the service list rail and nested outlet.
// ABOUTME: Delegates list loading and create dialog to the Speech feature layout.
import { createFileRoute } from "@tanstack/react-router";
import { SpeechLayout } from "../features/speech/SpeechLayout";

export const Route = createFileRoute("/speech")({
  component: SpeechLayout,
});
