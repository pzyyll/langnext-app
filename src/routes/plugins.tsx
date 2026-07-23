// ABOUTME: Parent Integrations route providing the instance list rail and nested outlet.
// ABOUTME: Delegates list loading and create dialog to the plugins feature layout.
import { createFileRoute } from "@tanstack/react-router";
import { PluginsLayout } from "../features/plugins/PluginsLayout";

export const Route = createFileRoute("/plugins")({
  component: PluginsLayout,
});
