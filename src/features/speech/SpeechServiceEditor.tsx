// ABOUTME: Selected Speech service editor shell matching OCR service editor layout.
// ABOUTME: Hosts Google Cloud TTS form with rename, enable, save, reset, and delete.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { Switch } from "@base-ui/react/switch";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ConfigEditorLayout, configEditorRenameInputClassName } from "../../components/layouts/ConfigEditorLayout";
import { useToast } from "../../components/toast/useToast";
import {
  dangerIconButtonClassName,
  iconButtonClassName,
  outlineButtonClassName,
  primaryButtonClassName,
  switchRootClassName,
  switchThumbClassName,
} from "../../components/ui";
import { settingsKeys, speechKeys } from "../../query/keys";
import { integrationDefinitionListOptions, integrationListOptions, speechListOptions } from "../../query/options";
import { deleteSpeechService, saveSpeechService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { SpeechServiceDto, SpeechServiceWrite } from "../../storage/types";
import { GoogleCloudTtsForm } from "./GoogleCloudTtsForm";
import {
  GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
  SPEECH_PITCH_DEFAULT,
  SPEECH_PITCH_MAX,
  SPEECH_PITCH_MIN,
  SPEECH_SPEAKING_RATE_DEFAULT,
  SPEECH_SPEAKING_RATE_MAX,
  SPEECH_SPEAKING_RATE_MIN,
  SPEECH_SYNTHESIZE_CAPABILITY_ID,
  defaultGoogleTtsPreferences,
} from "./speechProviderOptions";

export type SpeechServiceEditorProps = {
  speechServiceId: string;
};

type EditorDraft = {
  enabled: boolean;
  integrationInstanceId: string;
  capabilityId: string;
  preferencesSchemaVersion: number;
  speakingRate: number;
  pitch: number;
  expectedUpdatedAt: string;
};

function parseFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function draftFromDto(service: SpeechServiceDto): EditorDraft {
  const prefs = service.preferences ?? defaultGoogleTtsPreferences();
  return {
    enabled: service.enabled,
    integrationInstanceId: service.integrationInstanceId,
    capabilityId: service.capabilityId || SPEECH_SYNTHESIZE_CAPABILITY_ID,
    preferencesSchemaVersion: service.preferencesSchemaVersion || GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
    speakingRate: parseFiniteNumber((prefs as { speakingRate?: unknown }).speakingRate, SPEECH_SPEAKING_RATE_DEFAULT),
    pitch: parseFiniteNumber((prefs as { pitch?: unknown }).pitch, SPEECH_PITCH_DEFAULT),
    expectedUpdatedAt: service.updatedAt,
  };
}

function isDraftFieldsClean(draft: EditorDraft, service: SpeechServiceDto): boolean {
  const baseline = draftFromDto(service);
  return (
    draft.enabled === baseline.enabled &&
    draft.integrationInstanceId === baseline.integrationInstanceId &&
    draft.capabilityId === baseline.capabilityId &&
    draft.preferencesSchemaVersion === baseline.preferencesSchemaVersion &&
    draft.speakingRate === baseline.speakingRate &&
    draft.pitch === baseline.pitch
  );
}

/** Persist a rename without applying unsaved form fields. */
function renameWrite(service: SpeechServiceDto, displayName: string): SpeechServiceWrite {
  const prefs = service.preferences ?? defaultGoogleTtsPreferences();
  return {
    id: service.id,
    displayName,
    enabled: service.enabled,
    integrationInstanceId: service.integrationInstanceId,
    capabilityId: service.capabilityId || SPEECH_SYNTHESIZE_CAPABILITY_ID,
    preferencesSchemaVersion: service.preferencesSchemaVersion || GOOGLE_TTS_PREFERENCES_SCHEMA_VERSION,
    preferences: {
      speakingRate: parseFiniteNumber((prefs as { speakingRate?: unknown }).speakingRate, SPEECH_SPEAKING_RATE_DEFAULT),
      pitch: parseFiniteNumber((prefs as { pitch?: unknown }).pitch, SPEECH_PITCH_DEFAULT),
    },
    expectedUpdatedAt: service.updatedAt,
  };
}

export function SpeechServiceEditor({ speechServiceId }: SpeechServiceEditorProps) {
  const { t } = useTranslation();
  const servicesQuery = useQuery(speechListOptions());
  const service = (servicesQuery.data ?? []).find((item) => item.id === speechServiceId) ?? null;
  const loading = servicesQuery.isLoading;
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("speech.loadFailed")) : null;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-body-tight text-neutral" aria-live="polite">
          {t("speech.loadingService")}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <p className="text-body-tight text-error" role="alert">
          {error}
        </p>
        <Button
          type="button"
          className={outlineButtonClassName}
          onClick={() => {
            void servicesQuery.refetch();
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="flex flex-1 flex-col items-start gap-3 p-8">
        <h1 className="text-headline-md font-bold text-on-surface">{t("speech.notFound")}</h1>
        <p className="text-body-tight text-neutral">{t("speech.notFoundHint")}</p>
        <Link to="/speech" className={outlineButtonClassName}>
          {t("speech.backToList")}
        </Link>
      </div>
    );
  }

  // Remount only when the selected service changes so rename/save keep local draft state.
  return <SpeechServiceEditorLoaded key={service.id} service={service} />;
}

type SpeechServiceEditorLoadedProps = {
  service: SpeechServiceDto;
};

function SpeechServiceEditorLoaded({ service }: SpeechServiceEditorLoadedProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const integrationsQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());

  const [draft, setDraft] = useState<EditorDraft>(() => draftFromDto(service));
  const [trackedService, setTrackedService] = useState(service);
  const [savePending, setSavePending] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLElement | null>(null);

  // Accept remote service updates into the draft only while the form is clean.
  if (service.updatedAt !== trackedService.updatedAt || service.id !== trackedService.id) {
    const shouldResetDraft = service.id !== trackedService.id || isDraftFieldsClean(draft, trackedService);
    setTrackedService(service);
    if (shouldResetDraft) {
      setDraft(draftFromDto(service));
    }
  }

  useEffect(() => {
    if (!renaming) {
      return;
    }
    const node = renameInputRef.current;
    if (!node) {
      return;
    }
    node.focus();
    if (node instanceof HTMLInputElement) {
      node.select();
    }
  }, [renaming]);

  const isDirty = useMemo(() => !isDraftFieldsClean(draft, service), [draft, service]);

  const formDisabled = savePending || deletePending || renamePending;
  const renameDisabled = formDisabled;

  function updateDraft(patch: Partial<EditorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationError(null);
  }

  function seedService(next: SpeechServiceDto) {
    queryClient.setQueryData<SpeechServiceDto[]>(speechKeys.list(), (current) => {
      if (!current) {
        return [next];
      }
      const index = current.findIndex((item) => item.id === next.id);
      if (index < 0) {
        return [...current, next];
      }
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
    queryClient.setQueryData(speechKeys.detail(next.id), next);
  }

  function startRename() {
    setRenameValue(service.displayName);
    setRenameError(null);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameValue("");
    setRenameError(null);
  }

  async function commitRename() {
    const trimmed = renameValue.trim();
    if (!trimmed || renamePending) {
      return;
    }
    if (trimmed === service.displayName) {
      cancelRename();
      return;
    }

    setRenamePending(true);
    setRenameError(null);
    try {
      const saved = await saveSpeechService(renameWrite(service, trimmed));
      seedService(saved);
      setDraft((current) => ({ ...current, expectedUpdatedAt: saved.updatedAt }));
      setRenaming(false);
      setRenameValue("");
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } catch (error) {
      setRenameError(getIpcErrorMessage(error, t("speech.toast.renameFailed")));
    } finally {
      setRenamePending(false);
    }
  }

  async function handleSave() {
    if (savePending || !isDirty) {
      return;
    }

    if (!draft.integrationInstanceId) {
      setValidationError(t("speech.validation.integrationRequired"));
      return;
    }
    if (
      !Number.isFinite(draft.speakingRate) ||
      draft.speakingRate < SPEECH_SPEAKING_RATE_MIN ||
      draft.speakingRate > SPEECH_SPEAKING_RATE_MAX
    ) {
      setValidationError(
        t("speech.validation.speakingRateRange", {
          min: SPEECH_SPEAKING_RATE_MIN,
          max: SPEECH_SPEAKING_RATE_MAX,
        }),
      );
      return;
    }
    if (!Number.isFinite(draft.pitch) || draft.pitch < SPEECH_PITCH_MIN || draft.pitch > SPEECH_PITCH_MAX) {
      setValidationError(t("speech.validation.pitchRange", { min: SPEECH_PITCH_MIN, max: SPEECH_PITCH_MAX }));
      return;
    }

    const write: SpeechServiceWrite = {
      id: service.id,
      displayName: service.displayName,
      enabled: draft.enabled,
      integrationInstanceId: draft.integrationInstanceId,
      capabilityId: draft.capabilityId || SPEECH_SYNTHESIZE_CAPABILITY_ID,
      preferencesSchemaVersion: draft.preferencesSchemaVersion,
      preferences: {
        speakingRate: draft.speakingRate,
        pitch: draft.pitch,
      },
      expectedUpdatedAt: draft.expectedUpdatedAt,
    };

    setValidationError(null);
    setSavePending(true);
    try {
      const saved = await saveSpeechService(write);
      seedService(saved);
      setDraft(draftFromDto(saved));
      toast.success({ title: t("speech.toast.saved"), description: saved.displayName });
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } catch (error) {
      const message = getIpcErrorMessage(error, t("speech.toast.saveFailed"));
      setValidationError(message);
      toast.error({ title: t("speech.toast.saveFailed"), description: message });
      void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    } finally {
      setSavePending(false);
    }
  }

  async function handleDelete() {
    if (deletePending) {
      return;
    }
    setDeletePending(true);
    try {
      await deleteSpeechService(service.id);
    } catch (error) {
      const message = getIpcErrorMessage(error, t("speech.toast.deleteFailed"));
      toast.error({ title: t("speech.toast.deleteFailed"), description: message });
      // Rethrow so ConfirmDialog stays open (matches OCR editor).
      throw Object.assign(new Error(message), { cause: error });
    } finally {
      setDeletePending(false);
    }

    queryClient.setQueryData<SpeechServiceDto[]>(speechKeys.list(), (current) =>
      (current ?? []).filter((item) => item.id !== service.id),
    );
    queryClient.removeQueries({ queryKey: speechKeys.detail(service.id) });
    toast.success({ title: t("speech.toast.deleted"), description: service.displayName });
    void navigate({ to: "/speech" });
    void queryClient.invalidateQueries({ queryKey: speechKeys.all });
    // Backend clears defaultSpeechServiceId when the selected service is deleted.
    void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
  }

  function resetForm() {
    setDraft(draftFromDto(service));
    setValidationError(null);
  }

  return (
    <>
      <ConfigEditorLayout
        title={
          renaming ? (
            <form
              className="flex min-w-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void commitRename();
              }}
            >
              <Input
                ref={renameInputRef}
                className={configEditorRenameInputClassName}
                value={renameValue}
                onChange={(event) => {
                  setRenameValue(event.currentTarget.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !renamePending) {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                maxLength={128}
                spellCheck={false}
                autoComplete="off"
                disabled={renamePending}
              />
              <Button
                type="submit"
                className={iconButtonClassName}
                aria-label={t("speech.saveServiceName")}
                disabled={renamePending || !renameValue.trim()}
              >
                <IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
              </Button>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("speech.cancelRename")}
                disabled={renamePending}
                onClick={cancelRename}
              >
                <IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <h1 className="truncate text-headline-display font-bold text-on-surface">{service.displayName}</h1>
              <Button
                type="button"
                className={iconButtonClassName}
                aria-label={t("speech.renameService")}
                title={t("speech.renameService")}
                disabled={renameDisabled}
                onClick={startRename}
              >
                <IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
              </Button>
            </div>
          )
        }
        titleTrailing={
          <label className="flex shrink-0 items-center gap-2 text-body-tight text-on-surface">
            <Switch.Root
              checked={draft.enabled}
              disabled={formDisabled}
              className={switchRootClassName}
              aria-label={t("speech.enabledAria")}
              onCheckedChange={(checked) => {
                updateDraft({ enabled: checked });
              }}
            >
              <Switch.Thumb className={switchThumbClassName} />
            </Switch.Root>
          </label>
        }
        titleMeta={
          renameError ? (
            <p className="mb-2 text-body-tight text-error" role="alert">
              {renameError}
            </p>
          ) : null
        }
        footer={
          <>
            <Button
              type="button"
              className={`
                ${dangerIconButtonClassName}
                mr-auto
              `}
              aria-label={t("speech.deleteConfirmTitle")}
              title={t("speech.deleteConfirmTitle")}
              disabled={formDisabled}
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              <IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
            </Button>

            <Button type="button" className={outlineButtonClassName} disabled={formDisabled} onClick={resetForm}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className={`
                ${primaryButtonClassName}
                relative
              `}
              disabled={formDisabled || !isDirty}
              focusableWhenDisabled
              aria-busy={savePending}
              aria-label={savePending ? t("common.saving") : t("common.save")}
              onClick={() => {
                void handleSave();
              }}
            >
              <span className={savePending ? "invisible" : undefined} aria-hidden="true">
                {t("common.save")}
              </span>
              {savePending ? (
                <span
                  className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          </>
        }
      >
        <GoogleCloudTtsForm
          integrationInstanceId={draft.integrationInstanceId}
          capabilityId={draft.capabilityId}
          speakingRate={draft.speakingRate}
          pitch={draft.pitch}
          instances={integrationsQuery.data ?? []}
          definitions={definitionsQuery.data ?? []}
          disabled={formDisabled}
          onIntegrationInstanceIdChange={(instanceId, nextCapabilityId) => {
            updateDraft({
              integrationInstanceId: instanceId,
              capabilityId: nextCapabilityId,
            });
          }}
          onSpeakingRateChange={(value) => {
            updateDraft({ speakingRate: value });
          }}
          onPitchChange={(value) => {
            updateDraft({ pitch: value });
          }}
        />

        {validationError ? (
          <p className="mt-6 text-body-tight text-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </ConfigEditorLayout>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("speech.deleteConfirmTitle")}
        description={t("speech.deleteConfirm", { name: service.displayName })}
        confirmText={t("common.delete")}
        pendingText={t("common.deleting")}
        danger
        onConfirm={handleDelete}
      />
    </>
  );
}
