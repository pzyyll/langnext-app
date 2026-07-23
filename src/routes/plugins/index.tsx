// ABOUTME: Empty Integrations child route shown before an instance is selected.
// ABOUTME: Prompts the user to select or create a configuration instance.
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/plugins/")({
  component: PluginsEmptyPage,
});

function PluginsEmptyPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 p-8">
      <p className="max-w-md text-body-md text-neutral">{t("plugins.emptyPage")}</p>
    </div>
  );
}
