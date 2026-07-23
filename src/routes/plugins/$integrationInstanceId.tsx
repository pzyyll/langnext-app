// ABOUTME: Dynamic Integrations child route for one selected configuration instance.
// ABOUTME: Reads the instance ID from the URL and renders its configuration editor.
import { createFileRoute } from "@tanstack/react-router";
import { IntegrationEditor } from "../../features/plugins/IntegrationEditor";

export const Route = createFileRoute("/plugins/$integrationInstanceId")({
  component: IntegrationInstancePage,
});

function IntegrationInstancePage() {
  const { integrationInstanceId } = Route.useParams();
  return <IntegrationEditor integrationInstanceId={integrationInstanceId} />;
}
