// ABOUTME: Baidu-specific OCR configuration fields (API key, secret key, action).
// ABOUTME: Credential UX mirrors Models keep/replace/clear vault rules.
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useTranslation } from "react-i18next";
import { SelectField } from "../../components/SelectField";
import { inputClassName, outlineButtonClassName } from "../../components/ui";
import type { BaiduOcrAction } from "../../storage/types";

const fieldLabelClassName = "text-label-sm font-bold uppercase text-on-surface";

export type CredentialAction = "keep" | "replace" | "clear";

const BAIDU_ACTIONS: BaiduOcrAction[] = ["accurate", "accurate_basic", "general", "general_basic"];

const BAIDU_ACTION_LABEL_KEYS = {
  accurate: "ocr.baidu.actions.accurate",
  accurate_basic: "ocr.baidu.actions.accurate_basic",
  general: "ocr.baidu.actions.general",
  general_basic: "ocr.baidu.actions.general_basic",
} as const;

function baiduActionLabel(
  action: BaiduOcrAction,
  t: (key: (typeof BAIDU_ACTION_LABEL_KEYS)[BaiduOcrAction]) => string,
): string {
  return t(BAIDU_ACTION_LABEL_KEYS[action]);
}

export type BaiduOcrFormProps = {
  apiKey: string;
  secretKey: string;
  apiKeyAction: CredentialAction;
  secretKeyAction: CredentialAction;
  hasApiKey: boolean;
  hasSecretKey: boolean;
  baiduAction: BaiduOcrAction;
  disabled?: boolean;
  onApiKeyChange: (value: string) => void;
  onSecretKeyChange: (value: string) => void;
  onApiKeyActionChange: (action: CredentialAction) => void;
  onSecretKeyActionChange: (action: CredentialAction) => void;
  onBaiduActionChange: (action: BaiduOcrAction) => void;
};

export function BaiduOcrForm({
  apiKey,
  secretKey,
  apiKeyAction,
  secretKeyAction,
  hasApiKey,
  hasSecretKey,
  baiduAction,
  disabled = false,
  onApiKeyChange,
  onSecretKeyChange,
  onApiKeyActionChange,
  onSecretKeyActionChange,
  onBaiduActionChange,
}: BaiduOcrFormProps) {
  const { t } = useTranslation();

  const apiKeyDisabled = disabled || apiKeyAction === "clear";
  const secretKeyDisabled = disabled || secretKeyAction === "clear";

  const apiKeyPlaceholder =
    apiKeyAction === "clear"
      ? t("ocr.baidu.keyCleared")
      : hasApiKey
        ? t("ocr.baidu.keyStored")
        : t("ocr.baidu.apiKeyPlaceholder");
  const secretKeyPlaceholder =
    secretKeyAction === "clear"
      ? t("ocr.baidu.keyCleared")
      : hasSecretKey
        ? t("ocr.baidu.keyStored")
        : t("ocr.baidu.secretKeyPlaceholder");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-baidu-api-key">
          {t("ocr.baidu.apiKey")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="ocr-baidu-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`
              ${inputClassName}
              min-w-0 flex-1
            `}
            value={apiKey}
            disabled={apiKeyDisabled}
            placeholder={apiKeyPlaceholder}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onApiKeyChange(value);
              if (apiKeyAction === "clear") {
                onApiKeyActionChange(value.trim() ? "replace" : "keep");
              } else if (value.trim()) {
                onApiKeyActionChange("replace");
              } else if (apiKeyAction === "replace") {
                onApiKeyActionChange("keep");
              }
            }}
          />
          {hasApiKey ? (
            apiKeyAction !== "clear" ? (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onApiKeyChange("");
                  onApiKeyActionChange("clear");
                }}
              >
                {t("ocr.baidu.resetKey")}
              </Button>
            ) : (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onApiKeyChange("");
                  onApiKeyActionChange("keep");
                }}
              >
                {t("ocr.baidu.keepStoredKey")}
              </Button>
            )
          ) : null}
        </div>
        {apiKeyAction === "clear" ? (
          <p className="text-body-tight text-neutral">{t("ocr.baidu.keyRemovedOnSave")}</p>
        ) : null}
        {apiKeyAction === "replace" && apiKey.trim() ? (
          <p className="text-body-tight text-neutral">{t("ocr.baidu.keyReplaceHint")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label className={fieldLabelClassName} htmlFor="ocr-baidu-secret-key">
          {t("ocr.baidu.secretKey")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="ocr-baidu-secret-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={`
              ${inputClassName}
              min-w-0 flex-1
            `}
            value={secretKey}
            disabled={secretKeyDisabled}
            placeholder={secretKeyPlaceholder}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onSecretKeyChange(value);
              if (secretKeyAction === "clear") {
                onSecretKeyActionChange(value.trim() ? "replace" : "keep");
              } else if (value.trim()) {
                onSecretKeyActionChange("replace");
              } else if (secretKeyAction === "replace") {
                onSecretKeyActionChange("keep");
              }
            }}
          />
          {hasSecretKey ? (
            secretKeyAction !== "clear" ? (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onSecretKeyChange("");
                  onSecretKeyActionChange("clear");
                }}
              >
                {t("ocr.baidu.resetKey")}
              </Button>
            ) : (
              <Button
                type="button"
                className={outlineButtonClassName}
                disabled={disabled}
                onClick={() => {
                  onSecretKeyChange("");
                  onSecretKeyActionChange("keep");
                }}
              >
                {t("ocr.baidu.keepStoredKey")}
              </Button>
            )
          ) : null}
        </div>
        {secretKeyAction === "clear" ? (
          <p className="text-body-tight text-neutral">{t("ocr.baidu.keyRemovedOnSave")}</p>
        ) : null}
        {secretKeyAction === "replace" && secretKey.trim() ? (
          <p className="text-body-tight text-neutral">{t("ocr.baidu.keyReplaceHint")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <span className={fieldLabelClassName}>{t("ocr.baidu.action")}</span>
        <SelectField
          value={baiduAction}
          onValueChange={(value) => {
            if (BAIDU_ACTIONS.includes(value as BaiduOcrAction)) {
              onBaiduActionChange(value as BaiduOcrAction);
            }
          }}
          options={BAIDU_ACTIONS.map((action) => ({
            value: action,
            label: baiduActionLabel(action, t),
          }))}
          disabled={disabled}
          aria-label={t("ocr.baidu.action")}
        />
        <p className="text-body-tight text-neutral">{t("ocr.baidu.actionHint")}</p>
        <a
          href="https://ai.baidu.com/tech/ocr"
          target="_blank"
          rel="noreferrer"
          className="text-body-tight text-primary underline"
        >
          {t("ocr.baidu.officialLink")}
        </a>
      </div>
    </div>
  );
}
