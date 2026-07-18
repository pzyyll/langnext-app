// ABOUTME: Dynamic Models child route for one selected provider instance.
// ABOUTME: Reads the provider ID from the URL and renders its configuration editor.
import { createFileRoute } from "@tanstack/react-router";
import { ProviderEditor } from "../../features/models/ProviderEditor";

export const Route = createFileRoute("/models/$providerId")({
  component: ProviderPage,
});

function ProviderPage() {
  const { providerId } = Route.useParams();
  return <ProviderEditor providerId={providerId} />;
}
