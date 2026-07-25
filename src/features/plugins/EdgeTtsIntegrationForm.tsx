// ABOUTME: Edge TTS integration form for the configurable OpenAI-compatible API base URL.
// ABOUTME: Credential-free; no project, token, or service-account fields.
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import { inputClassName } from "../../components/ui";
import { EDGE_TTS_DEFAULT_BASE_URL } from "../../storage/types";
import type { EdgeTtsIntegrationDraft } from "./integrationDraft";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type EdgeTtsIntegrationFormProps = {
  draft: EdgeTtsIntegrationDraft;
  disabled?: boolean;
  onChange: (next: EdgeTtsIntegrationDraft) => void;
};

function baseHostname(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname.trim();
    return host || null;
  } catch {
    return null;
  }
}

export function EdgeTtsIntegrationForm({ draft, disabled = false, onChange }: EdgeTtsIntegrationFormProps) {
  const { t } = useTranslation();
  const hostname = baseHostname(draft.baseUrl.trim() || EDGE_TTS_DEFAULT_BASE_URL);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="integration-edge-tts-base-url">
          {t("plugins.edgeTts.baseUrl")}
        </label>
        <Input
          id="integration-edge-tts-base-url"
          autoComplete="off"
          spellCheck={false}
          className={inputClassName}
          value={draft.baseUrl}
          disabled={disabled}
          placeholder={EDGE_TTS_DEFAULT_BASE_URL}
          onChange={(event) => {
            onChange({ ...draft, baseUrl: event.currentTarget.value });
          }}
        />
        <p className="text-body-tight text-neutral">
          {hostname ? t("plugins.edgeTts.baseUrlHintWithHost", { host: hostname }) : t("plugins.edgeTts.baseUrlHint")}
        </p>
      </div>

      <p className="text-body-tight text-neutral" role="note">
        {t("plugins.edgeTts.privacyNote")}
      </p>

      <a
        href="https://github.com/wangwangit/tts"
        target="_blank"
        rel="noreferrer"
        className="text-body-tight text-primary underline"
      >
        {t("plugins.edgeTts.docsLink")}
      </a>
    </div>
  );
}
