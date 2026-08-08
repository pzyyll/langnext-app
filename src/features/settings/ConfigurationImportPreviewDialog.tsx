// ABOUTME: Merge/Copy selection, preview, and confirmation dialog for configuration import.
// ABOUTME: Dispatches only through configurationImportPreviewState; apply sends previewId only.
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Fieldset } from "@base-ui/react/fieldset";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import {
  dialogBackdropClassName,
  dialogPopupClassName,
  iconButtonClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  radioClassName,
  radioIndicatorClassName,
} from "../../components/ui";
import type { ImportConflictMode, ImportResult } from "../../storage/types";
import { getUserErrorMessage } from "../userErrorMessage";
import {
  canApplyImportPreview,
  closeImportPreviewDialog,
  failImportPreview,
  finishImportApply,
  finishImportPreviewLoad,
  initialImportPreviewDialogState,
  openImportPreviewDialog,
  selectImportPreviewMode,
  startImportApply,
  startImportPreviewLoad,
} from "./configurationImportPreviewState";
import type { ConfigurationImportPreviewState } from "./configurationImportPreviewState";
import { runApplyPreparedConfigurationImport, runPrepareConfigurationImportFromFile } from "./configurationTransfer";
import {
  IMPORT_AUTH_LEAD_IN_KEY,
  IMPORT_INACTIVE_RUNTIME_COPY_KEY,
  groupImportRuntimeRequirements,
  importAuthenticationCategories,
  importAuthenticationCategoryLabelKey,
  importGraphCountSummaries,
  importHasPackageBackedRuntimes,
  importModeLabelKey,
  importRuntimeDetailRows,
} from "./importPreviewPresentation";

export type ConfigurationImportPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once after a successful apply; the route owns invalidation and toasts. */
  onApplied: (result: ImportResult) => void;
};

export function ConfigurationImportPreviewDialog({
  open,
  onOpenChange,
  onApplied,
}: ConfigurationImportPreviewDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<ConfigurationImportPreviewState>(initialImportPreviewDialogState);

  const busy = state.phase.kind === "loading" || state.phase.kind === "applying";

  function handleOpenChange(next: boolean) {
    if (!next) {
      setState(closeImportPreviewDialog(state));
      onOpenChange(false);
      return;
    }
    setState(openImportPreviewDialog(state));
    onOpenChange(true);
  }

  async function handlePreview() {
    setState((s) => startImportPreviewLoad(s));
    try {
      const result = await runPrepareConfigurationImportFromFile(state.mode);
      setState((s) => finishImportPreviewLoad(s, result));
    } catch (error) {
      const message = getUserErrorMessage(error, t("settings.backup.previewFailed"));
      setState((s) => failImportPreview(s, message));
    }
  }

  async function handleApply() {
    if (state.phase.kind !== "previewed") {
      return;
    }
    // Capture the opaque preview id before replacing the phase. The apply payload never
    // carries the document or the mode; only this id is sent to the host.
    const previewId = state.phase.preview.previewId ?? "";
    // Enter `applying` before any IPC so a duplicate Apply cannot start a second request
    // and the rendered Apply control disappears while the host operation runs.
    const applying = startImportApply(state);
    if (applying.phase.kind !== "applying") {
      return;
    }
    setState(applying);
    try {
      const result = await runApplyPreparedConfigurationImport(previewId);
      // Finish only from `applying`. Closing the dialog mid-apply does not cancel the
      // started host operation; the visible transition is dropped, but a completed apply
      // still runs the route workflow below.
      setState((current) => (current.phase.kind === "applying" ? finishImportApply(current, result) : current));
      if (result.status === "applied") {
        onApplied(result.result);
        handleOpenChange(false);
      }
    } catch (error) {
      const message = getUserErrorMessage(error, t("settings.backup.importFailed"));
      // The current phase is already `applying`, so the error lands in the visible phase.
      setState((current) => failImportPreview(current, message));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClassName} />
        <Dialog.Popup
          className={`
            ${dialogPopupClassName}
            max-h-[min(90vh,42rem)] w-xl overflow-y-auto
          `}
        >
          {/* Persistent corner close: the always-available dialog affordance in every
              phase, including busy ones. Closing never cancels an already-started host
              operation; a completed apply still runs the route workflow. */}
          <Dialog.Close
            className={`
              ${iconButtonClassName}
              absolute top-2 right-2
            `}
            aria-label={t("common.close")}
          >
            <IconMaterialSymbolsLightClose className="size-4" />
          </Dialog.Close>
          <Dialog.Title className="text-title-dialog font-bold text-on-surface">
            {t("settings.backup.importDialogTitle")}
          </Dialog.Title>
          <Dialog.Description className="text-body-tight text-neutral">
            {t("settings.backup.importDialogDescription")}
          </Dialog.Description>
          {state.phase.kind === "idle" ? (
            <>
              <Fieldset.Root
                render={
                  <RadioGroup
                    value={state.mode}
                    onValueChange={(value) => {
                      setState((s) => selectImportPreviewMode(s, value as ImportConflictMode));
                    }}
                    className="flex flex-col gap-2"
                  />
                }
              >
                <Fieldset.Legend className="text-body-tight font-bold text-on-surface">
                  {t("settings.backup.importConflictMode")}
                </Fieldset.Legend>
                <ModeOption
                  value="merge"
                  selected={state.mode === "merge"}
                  label={t("settings.backup.importModeMerge")}
                  description={t("settings.backup.importModeMergeDescription")}
                  radioClassName={radioClassName}
                  radioIndicatorClassName={radioIndicatorClassName}
                />
                <ModeOption
                  value="copy"
                  selected={state.mode === "copy"}
                  label={t("settings.backup.importModeCopy")}
                  description={t("settings.backup.importModeCopyDescription")}
                  radioClassName={radioClassName}
                  radioIndicatorClassName={radioIndicatorClassName}
                />
              </Fieldset.Root>
              <DialogActions>
                <Button type="button" className={outlineButtonClassName} onClick={() => handleOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" className={primaryButtonClassName} onClick={() => void handlePreview()}>
                  {t("settings.backup.chooseFile")}
                </Button>
              </DialogActions>
            </>
          ) : null}

          {state.phase.kind === "loading" ? (
            <p className="text-body-tight text-neutral">{t("settings.backup.previewing")}</p>
          ) : null}

          {state.phase.kind === "invalid" ? (
            <InvalidPreviewBody
              state={state}
              onRetry={() => void handlePreview()}
              onCancel={() => handleOpenChange(false)}
            />
          ) : null}

          {state.phase.kind === "previewed" ? (
            <PreviewBody
              state={state}
              busy={busy}
              onApply={() => void handleApply()}
              onRetry={() => void handlePreview()}
              onCancel={() => handleOpenChange(false)}
            />
          ) : null}

          {state.phase.kind === "applying" ? (
            <p className="text-body-tight text-neutral">{t("settings.backup.applying")}</p>
          ) : null}

          {state.phase.kind === "applied" || state.phase.kind === "not_applied" ? (
            <p className="text-body-tight text-neutral">
              {state.phase.kind === "applied"
                ? t("settings.backup.importSuccess")
                : t("settings.backup.importNotApplied")}
            </p>
          ) : null}

          {state.phase.kind === "conflict" ? (
            <RetryableErrorBody
              message={
                state.phase.conflictKind === "expired"
                  ? t("settings.backup.previewConflictExpired")
                  : t("settings.backup.previewConflictStale")
              }
              onRetry={() => void handlePreview()}
              onCancel={() => handleOpenChange(false)}
            />
          ) : null}

          {state.phase.kind === "error" ? (
            <RetryableErrorBody
              message={state.phase.message}
              onRetry={() => void handlePreview()}
              onCancel={() => handleOpenChange(false)}
            />
          ) : null}

          {state.phase.kind === "applied" || state.phase.kind === "not_applied" ? (
            <DialogActions>
              <Button type="button" className={outlineButtonClassName} onClick={() => handleOpenChange(false)}>
                {t("common.close")}
              </Button>
            </DialogActions>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type ModeOptionProps = {
  value: ImportConflictMode;
  selected: boolean;
  label: string;
  description: string;
  radioClassName: string;
  radioIndicatorClassName: string;
};

/** Right-aligned dialog action row shared by every phase body. */
function DialogActions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2">{children}</div>;
}

function ModeOption({ value, selected, label, description, radioClassName, radioIndicatorClassName }: ModeOptionProps) {
  return (
    <label
      className={`
        flex items-start gap-2 border border-line p-2 text-body-tight select-none
        ${selected ? "bg-surface-2 text-on-surface" : "bg-surface text-neutral"}
      `}
    >
      <Radio.Root value={value} className={radioClassName}>
        <Radio.Indicator className={radioIndicatorClassName} />
      </Radio.Root>
      <span className="flex flex-col gap-1">
        <span className="font-bold text-on-surface">{label}</span>
        <span className="text-neutral">{description}</span>
      </span>
    </label>
  );
}

function RetryableErrorBody({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-body-tight text-error" role="alert">
        {message}
      </p>
      <DialogActions>
        <Button type="button" className={outlineButtonClassName} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" className={primaryButtonClassName} onClick={onRetry}>
          {t("settings.backup.retryPreview")}
        </Button>
      </DialogActions>
    </>
  );
}

function InvalidPreviewBody({
  state,
  onRetry,
  onCancel,
}: {
  state: ConfigurationImportPreviewState;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const errors = state.phase.kind === "invalid" ? state.phase.preview.validationErrors : [];
  return (
    <>
      <p className="text-body-tight text-error" role="alert">
        {t("settings.backup.importInvalid")}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-body-tight text-neutral">
        {errors.map((error) => (
          <li key={error} className="wrap-break-word">
            {error}
          </li>
        ))}
      </ul>
      <DialogActions>
        <Button type="button" className={outlineButtonClassName} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" className={primaryButtonClassName} onClick={onRetry}>
          {t("settings.backup.retryPreview")}
        </Button>
      </DialogActions>
    </>
  );
}

function PreviewBody({
  state,
  busy,
  onApply,
  onRetry,
  onCancel,
}: {
  state: ConfigurationImportPreviewState;
  busy: boolean;
  onApply: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (state.phase.kind !== "previewed") {
    return null;
  }
  const { preview } = state.phase;
  const counts = importGraphCountSummaries(preview);
  const authCategories = importAuthenticationCategories(preview);
  const runtimeGroups = groupImportRuntimeRequirements(preview.runtimeRequirements);
  const hasPackageBacked = importHasPackageBackedRuntimes(preview.runtimeRequirements);

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2 text-body-tight">
          <span className="font-bold text-on-surface">{t("settings.backup.importMode")}</span>
          <span className="text-neutral">{t(importModeLabelKey(state.mode))}</span>
        </div>
        <section className="flex flex-col gap-1">
          <h3 className="text-body-bold font-bold text-on-surface">{t("settings.backup.importChanges")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-body-tight text-neutral">
            {counts.map((summary) => (
              <li key={summary.kind}>
                {t(summary.labelKey)}:{" "}
                {[
                  summary.create > 0 ? t("settings.backup.countNew", { count: summary.create }) : null,
                  summary.update > 0 ? t("settings.backup.countUpdated", { count: summary.update }) : null,
                  summary.copy > 0 ? t("settings.backup.countCopied", { count: summary.copy }) : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </li>
            ))}
          </ul>
        </section>

        {authCategories.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-body-tight text-neutral">{t(IMPORT_AUTH_LEAD_IN_KEY)}</p>
            <ul className="list-disc space-y-1 pl-5 text-body-tight text-neutral">
              {authCategories.map((category) => (
                <li key={category}>{t(importAuthenticationCategoryLabelKey(category))}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview.defaultProfileCleared ? (
          <p className="text-body-tight text-neutral">{t("settings.backup.defaultProfileClearedNote")}</p>
        ) : null}

        {runtimeGroups.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-body-bold font-bold text-on-surface">{t("settings.backup.runtimeTitle")}</h3>
            {runtimeGroups.map((group) => (
              <div key={group.action} className="flex flex-col gap-1">
                <p className="text-body-tight font-bold text-on-surface">{t(group.actionLabelKey)}</p>
                <ul className="list-disc space-y-2 pl-5 text-body-tight text-neutral">
                  {group.items.map((entry) => (
                    <li key={`${entry.subjectKind}-${entry.subjectId}-${entry.adapterId ?? ""}`}>
                      <span className="font-bold text-on-surface">{entry.displayLabel}</span>
                      <dl className="flex flex-col gap-0.5">
                        {importRuntimeDetailRows(entry).map((row) => (
                          <div key={row.labelKey} className="flex flex-col gap-0">
                            <dt className="text-neutral">{t(row.labelKey)}</dt>
                            <dd
                              className={`
                                text-on-surface
                                ${row.valueIsLabelKey ? "" : "font-mono text-code-inline wrap-break-word"}
                              `}
                            >
                              {row.valueIsLabelKey ? t(row.value) : row.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}

        {hasPackageBacked ? (
          <p className="text-body-tight text-neutral">{t(IMPORT_INACTIVE_RUNTIME_COPY_KEY)}</p>
        ) : null}
      </div>

      <DialogActions>
        <Button type="button" className={outlineButtonClassName} disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" className={outlineButtonClassName} disabled={busy} onClick={onRetry}>
          {t("settings.backup.retryPreview")}
        </Button>
        <Button
          type="button"
          className={primaryButtonClassName}
          disabled={busy || !canApplyImportPreview(state)}
          onClick={onApply}
        >
          {busy ? t("settings.backup.applying") : t("settings.backup.applyImport")}
        </Button>
      </DialogActions>
    </>
  );
}
