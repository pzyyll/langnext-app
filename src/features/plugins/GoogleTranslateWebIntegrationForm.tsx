// ABOUTME: Typed Google Web translation form (GTX / HTTPS proxy channel).
// ABOUTME: Never shows Cloud project, location, or service-account fields.
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../components/SelectField";
import { inputClassName } from "../../components/ui";
import type { GoogleTranslateWebChannel } from "../../storage/types";
import { GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL } from "../../storage/types";
import type { GoogleTranslateWebIntegrationDraft } from "./integrationDraft";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type GoogleTranslateWebIntegrationFormProps = {
  draft: GoogleTranslateWebIntegrationDraft;
  disabled?: boolean;
  onChange: (next: GoogleTranslateWebIntegrationDraft) => void;
};

function proxyHostname(proxyUrl: string): string | null {
  try {
    const host = new URL(proxyUrl).hostname.trim();
    return host || null;
  } catch {
    return null;
  }
}

export function GoogleTranslateWebIntegrationForm({
  draft,
  disabled = false,
  onChange,
}: GoogleTranslateWebIntegrationFormProps) {
  const { t } = useTranslation();
  const hostname = draft.channel === "https_proxy" ? proxyHostname(draft.proxyUrl) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-web-channel">
          {t("plugins.googleTranslateWeb.channel")}
        </label>
        <SelectField
          id="integration-web-channel"
          value={draft.channel}
          disabled={disabled}
          onValueChange={(value) => {
            const channel = (value === "https_proxy" ? "https_proxy" : "gtx") as GoogleTranslateWebChannel;
            onChange({
              ...draft,
              channel,
              proxyUrl:
                channel === "https_proxy" && !draft.proxyUrl.trim()
                  ? GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL
                  : draft.proxyUrl,
            });
          }}
          options={[
            { value: "gtx", label: t("plugins.googleTranslateWeb.channelGtx") },
            { value: "https_proxy", label: t("plugins.googleTranslateWeb.channelProxy") },
          ]}
        />
      </div>

      {draft.channel === "gtx" ? (
        <p className="text-body-tight text-neutral" role="note">
          {t("plugins.googleTranslateWeb.gtxWarning")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label className={fieldLabelClassName} htmlFor="integration-web-proxy-url">
              {t("plugins.googleTranslateWeb.proxyUrl")}
            </label>
            <Input
              id="integration-web-proxy-url"
              autoComplete="off"
              spellCheck={false}
              className={inputClassName}
              value={draft.proxyUrl}
              disabled={disabled}
              placeholder={GOOGLE_TRANSLATE_WEB_DEFAULT_PROXY_URL}
              onChange={(event) => {
                onChange({ ...draft, proxyUrl: event.currentTarget.value });
              }}
            />
          </div>
          <p className="text-body-tight text-neutral" role="note">
            {hostname
              ? t("plugins.googleTranslateWeb.proxyWarningWithHost", { host: hostname })
              : t("plugins.googleTranslateWeb.proxyWarning")}
          </p>
        </>
      )}

      <p className="text-body-tight text-neutral" role="note">
        {t("plugins.googleTranslateWeb.privacyNote")}
      </p>
    </div>
  );
}
