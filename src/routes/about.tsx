// ABOUTME: About route describing the project stack and structure.
// ABOUTME: Pure frontend page used to verify TanStack file-based routing.
import { createFileRoute } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

const stackKeys = ["tauri", "react", "router", "baseUi", "tailwind", "tooling"] as const;

const codeClassName = "border border-line bg-code px-1.5 py-0.5 font-mono text-code-inline text-on-surface";

function AboutPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h1 className="text-headline-md font-bold text-on-surface">{t("about.title")}</h1>
        <p className="max-w-2xl text-body-md text-neutral">
          <Trans
            i18nKey="about.description"
            components={{
              src: <code className={codeClassName} />,
              tauri: <code className={codeClassName} />,
            }}
          />
        </p>
      </section>

      <ul className="grid gap-3 sm:grid-cols-2">
        {stackKeys.map((key) => (
          <li key={key} className="shadow-frame border border-line bg-surface p-gutter">
            <div className="text-body-bold font-bold text-on-surface">{t(`about.stack.${key}.name`)}</div>
            <p className="mt-1 text-body-tight text-neutral">{t(`about.stack.${key}.detail`)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
