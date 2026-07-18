// ABOUTME: Parent Translate route providing a nested outlet for child pages.
// ABOUTME: Layout-only shell so /translate and /translate/profiles render as siblings.
import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/translate")({
  component: TranslateLayout,
});

function TranslateLayout() {
  return <Outlet />;
}
