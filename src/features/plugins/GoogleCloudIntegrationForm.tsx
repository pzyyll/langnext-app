// ABOUTME: Typed Google Cloud integration form (project, location, proxy, service-account).
// ABOUTME: Never populates the service-account input from DTO data; shows stored/not-stored only.
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../components/SelectField";
import { inputClassName, outlineButtonClassName } from "../../components/ui";
import type { ProxyMode } from "../../storage/types";
import type { CredentialAction, GoogleCloudIntegrationDraft } from "./integrationDraft";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type GoogleCloudIntegrationFormProps = {
  draft: GoogleCloudIntegrationDraft;
  disabled?: boolean;
  onChange: (next: GoogleCloudIntegrationDraft) => void;
};

export function GoogleCloudIntegrationForm({ draft, disabled = false, onChange }: GoogleCloudIntegrationFormProps) {
  const { t } = useTranslation();

  const secretDisabled = disabled || draft.serviceAccountAction === "clear";
  const secretPlaceholder =
    draft.serviceAccountAction === "clear"
      ? t("plugins.googleCloud.credentialCleared")
      : draft.hasServiceAccount
        ? t("plugins.googleCloud.credentialStored")
        : t("plugins.googleCloud.credentialPlaceholder");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-project-id">
          {t("plugins.googleCloud.projectId")}
        </label>
        <Input
          id="integration-project-id"
          autoComplete="off"
          spellCheck={false}
          className={inputClassName}
          value={draft.projectId}
          disabled={disabled}
          placeholder={t("plugins.googleCloud.projectIdPlaceholder")}
          onChange={(event) => {
            onChange({ ...draft, projectId: event.currentTarget.value });
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-location">
          {t("plugins.googleCloud.location")}
        </label>
        <Input
          id="integration-location"
          autoComplete="off"
          spellCheck={false}
          className={inputClassName}
          value={draft.location}
          disabled={disabled}
          placeholder={t("plugins.googleCloud.locationPlaceholder")}
          onChange={(event) => {
            onChange({ ...draft, location: event.currentTarget.value });
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-proxy-mode">
          {t("plugins.googleCloud.proxyMode")}
        </label>
        <SelectField
          id="integration-proxy-mode"
          value={draft.proxyMode}
          disabled={disabled}
          onValueChange={(value) => {
            const proxyMode = (value === "direct" ? "direct" : "inherit") as ProxyMode;
            onChange({ ...draft, proxyMode });
          }}
          options={[
            { value: "inherit", label: t("plugins.googleCloud.proxyInherit") },
            { value: "direct", label: t("plugins.googleCloud.proxyDirect") },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-service-account">
          {t("plugins.googleCloud.serviceAccount")}
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <textarea
            id="integration-service-account"
            autoComplete="off"
            spellCheck={false}
            className={`
              ${inputClassName}
              min-h-28 min-w-0 flex-1 font-mono text-body-tight
            `}
            value={draft.serviceAccountJson}
            disabled={secretDisabled}
            placeholder={secretPlaceholder}
            onChange={(event) => {
              const value = event.currentTarget.value;
              let serviceAccountAction: CredentialAction = draft.serviceAccountAction;
              if (draft.serviceAccountAction === "clear") {
                serviceAccountAction = value.trim() ? "replace" : "keep";
              } else if (value.trim()) {
                serviceAccountAction = "replace";
              } else if (draft.serviceAccountAction === "replace") {
                serviceAccountAction = "keep";
              }
              onChange({
                ...draft,
                serviceAccountJson: value,
                serviceAccountAction,
              });
            }}
          />
          {draft.hasServiceAccount ? (
            draft.serviceAccountAction !== "clear" ? (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onChange({
                    ...draft,
                    serviceAccountJson: "",
                    serviceAccountAction: "clear",
                  });
                }}
              >
                {t("plugins.googleCloud.resetCredential")}
              </Button>
            ) : (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onChange({
                    ...draft,
                    serviceAccountJson: "",
                    serviceAccountAction: "keep",
                  });
                }}
              >
                {t("plugins.googleCloud.keepStoredCredential")}
              </Button>
            )
          ) : null}
        </div>
        {draft.serviceAccountAction === "clear" ? (
          <p className="text-body-tight text-neutral">{t("plugins.googleCloud.credentialRemovedOnSave")}</p>
        ) : null}
        {draft.serviceAccountAction === "replace" && draft.serviceAccountJson.trim() ? (
          <p className="text-body-tight text-neutral">{t("plugins.googleCloud.credentialReplaceHint")}</p>
        ) : null}
      </div>
    </div>
  );
}
