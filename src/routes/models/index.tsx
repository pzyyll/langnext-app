// ABOUTME: Empty Models child route shown before a channel is selected.
// ABOUTME: Prompts the user to select or create a provider instance.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/models/")({
	component: ModelsEmptyPage,
});

function ModelsEmptyPage() {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 p-8">
			<h1 className="text-2xl font-bold text-ink">Models</h1>
			<p className="max-w-md text-sm leading-6 text-muted">
				Select a channel from the list, or use + to create a provider instance. Connection settings and models appear
				here once a channel is selected.
			</p>
		</div>
	);
}
