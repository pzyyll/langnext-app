// ABOUTME: Empty Models child route shown before a channel is selected.
// ABOUTME: Prompts the user to select or create a provider instance.
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/models/")({
  component: ModelsEmptyPage,
});

function ModelsEmptyPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 p-8">
      <h1 className="text-headline-md font-bold text-on-surface">{t("models.title")}</h1>
      <p className="max-w-md text-body-md text-neutral">{t("models.emptyPage")}</p>
    </div>
  );
}
