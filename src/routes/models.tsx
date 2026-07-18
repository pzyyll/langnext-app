// ABOUTME: Parent Models route providing the channel sidebar and nested outlet.
// ABOUTME: Delegates provider loading and channel creation to the feature layout.
import { createFileRoute } from "@tanstack/react-router";
import { ModelsLayout } from "../features/models/ModelsLayout";

export const Route = createFileRoute("/models")({
  component: ModelsLayout,
});
