// ABOUTME: Root path entry that redirects into the primary Translate workspace.
// ABOUTME: Keeps `/` valid without shipping a dedicated Home page.
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/translate" });
  },
});
