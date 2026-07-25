// ABOUTME: Speech feature layout with service list rail, nested editor outlet, and header tools.
// ABOUTME: Loads Speech services via Query; URL selection + default Speech picker.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { ConfigRailHeader } from "../../components/layouts/ConfigRailHeader";
import { PageLayout } from "../../components/layouts/PageLayout";
import { SelectField } from "../../components/SelectField";
import { useToast } from "../../components/toast/useToast";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { settingsKeys, speechKeys } from "../../query/keys";
import { appSettingsOptions, integrationListOptions, speechListOptions } from "../../query/options";
import { setAppDefaultSpeechService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { AppSettingsDto, SpeechServiceDto } from "../../storage/types";
import { EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID } from "../../storage/types";
import { AddSpeechServiceDialog } from "./AddSpeechServiceDialog";
import { SpeechContext } from "./SpeechContext";
import { getSpeechProviderIcon } from "./speechProviderOptions";

/** Select value representing no default Speech service. */
const NO_DEFAULT_SPEECH_SERVICE_VALUE = "";
/** Compact select width for the page-header toolbar control. */
const DEFAULT_SPEECH_SELECT_WIDTH_CLASS = "w-48";

export function SpeechLayout() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { speechServiceId?: string };
  const selectedId = params.speechServiceId;

  const servicesQuery = useQuery(speechListOptions());
  const settingsQuery = useQuery(appSettingsOptions());
  const integrationsQuery = useQuery(integrationListOptions());
  const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
  const integrationById = useMemo(() => {
    const map = new Map<string, { displayName: string; pluginId: string }>();
    for (const instance of integrationsQuery.data ?? []) {
      map.set(instance.id, { displayName: instance.displayName, pluginId: instance.pluginId });
    }
    return map;
  }, [integrationsQuery.data]);
  const loading = servicesQuery.isLoading;
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("speech.loadFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);

  const defaultSpeechServiceId = settingsQuery.data?.defaultSpeechServiceId ?? null;

  const defaultSpeechOptions = useMemo(
    () => [
      { value: NO_DEFAULT_SPEECH_SERVICE_VALUE, label: t("speech.defaultSpeech.none") },
      ...services.map((service) => ({
        value: service.id,
        label: service.displayName,
      })),
    ],
    [services, t],
  );

  const defaultSpeechExtraOptions = useMemo(() => {
    if (!defaultSpeechServiceId) return undefined;
    if (services.some((service) => service.id === defaultSpeechServiceId)) return undefined;
    return [{ value: defaultSpeechServiceId, label: t("speech.defaultSpeech.missing") }];
  }, [defaultSpeechServiceId, services, t]);

  const setDefaultSpeechMutation = useMutation({
    mutationFn: (nextId: string | null) => setAppDefaultSpeechService(nextId),
    onSuccess: (settings) => {
      queryClient.setQueryData<AppSettingsDto>(settingsKeys.detail(), settings);
    },
    onError: (mutationError) => {
      const message = getIpcErrorMessage(mutationError, t("speech.toast.defaultFailed"));
      toast.error({ title: t("speech.toast.defaultFailed"), description: message });
    },
  });

  // When the Speech tab opens with services already configured but none selected,
  // default to the first service so the editor is immediately visible.
  useEffect(() => {
    if (loading || error) return;
    if (selectedId) return;
    if (services.length === 0) return;
    void navigate({
      to: "/speech/$speechServiceId",
      params: { speechServiceId: services[0].id },
    });
  }, [services, loading, error, selectedId, navigate]);

  const contextValue = useMemo(() => ({ ready: true as const }), []);

  const defaultSpeechSelectId = "speech-default";
  const defaultSelectDisabled = setDefaultSpeechMutation.isPending || settingsQuery.isLoading || services.length === 0;

  function pluginDisplayName(pluginId: string): string {
    if (pluginId === GOOGLE_CLOUD_PLUGIN_ID) {
      return t("plugins.googleCloud.name");
    }
    if (pluginId === EDGE_TTS_PLUGIN_ID) {
      return t("plugins.edgeTts.name");
    }
    return pluginId;
  }

  return (
    <SpeechContext.Provider value={contextValue}>
      <PageLayout
        title={t("speech.title")}
        contentClassName="overflow-hidden"
        actions={
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor={defaultSpeechSelectId} className="shrink-0 text-label-sm text-neutral uppercase">
              {t("speech.defaultSpeech.label")}
            </label>
            <SelectField
              id={defaultSpeechSelectId}
              compact
              className={DEFAULT_SPEECH_SELECT_WIDTH_CLASS}
              value={defaultSpeechServiceId ?? NO_DEFAULT_SPEECH_SERVICE_VALUE}
              onValueChange={(value) => {
                const nextId = !value || value === NO_DEFAULT_SPEECH_SERVICE_VALUE ? null : value;
                if (nextId === defaultSpeechServiceId) return;
                setDefaultSpeechMutation.mutate(nextId);
              }}
              options={defaultSpeechOptions}
              extraOptions={defaultSpeechExtraOptions}
              disabled={defaultSelectDisabled}
              placeholder={services.length === 0 ? t("speech.defaultSpeech.empty") : undefined}
              aria-label={t("speech.defaultSpeech.aria")}
            />
          </div>
        }
      >
        <aside
          className="
            flex w-models-rail shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest
          "
          aria-label={t("speech.services")}
        >
          <ConfigRailHeader>{t("speech.services")}</ConfigRailHeader>

          <div className="flex min-h-0 flex-1 flex-col">
            {loading ? (
              <p className="p-2 text-body-tight text-neutral" aria-live="polite">
                {t("speech.loading")}
              </p>
            ) : null}

            {error ? (
              <div className="flex flex-col gap-2 p-2" role="alert">
                <p className="text-body-tight text-error">{error}</p>
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
            ) : null}

            {!loading && !error && services.length === 0 ? (
              <p className="p-2 text-body-tight text-neutral">{t("speech.emptyList")}</p>
            ) : null}

            {!loading && !error && services.length > 0 ? (
              <ul
                className="min-h-0 flex-1 list-none overflow-y-auto p-0"
                role="listbox"
                aria-label={t("speech.services")}
              >
                {services.map((service) => {
                  const active = service.id === selectedId;
                  const integration = integrationById.get(service.integrationInstanceId);
                  const integrationName = integration?.displayName ?? t("speech.provider.pluginUnknownInstance");
                  const pluginName = integration
                    ? pluginDisplayName(integration.pluginId)
                    : t("speech.provider.pluginUnknownInstance");
                  const providerLabel = t("speech.provider.pluginNamed", {
                    plugin: pluginName,
                    name: integrationName,
                  });
                  const ProviderIcon = getSpeechProviderIcon(integration?.pluginId);
                  return (
                    <li key={service.id} role="option" aria-selected={active}>
                      <Link
                        to="/speech/$speechServiceId"
                        params={{ speechServiceId: service.id }}
                        className={cn(
                          `
                            group flex items-center gap-1 border-l-4 px-2 py-1.5 text-left text-body-tight
                            text-on-surface transition-colors
                          `,
                          active
                            ? "border-tertiary bg-surface-container-low"
                            : `
                              border-transparent
                              hover:bg-surface-container-highest
                            `,
                          !service.enabled && "opacity-60",
                        )}
                        title={service.displayName}
                      >
                        <span className="inline-flex shrink-0" title={providerLabel}>
                          <ProviderIcon className="size-4" aria-label={providerLabel} />
                        </span>
                        <span className={cn("min-w-0 flex-1 truncate", active ? "font-bold" : "font-normal")}>
                          {service.displayName}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-outline p-gutter">
            <Button
              type="button"
              className={`
                ${outlineButtonClassName}
                w-full bg-surface-2
                hover:not-data-disabled:bg-surface-3
              `}
              aria-label={t("speech.addAria")}
              onClick={() => {
                setAddOpen(true);
              }}
            >
              <span className="text-headline-sm leading-none">+</span>
            </Button>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </PageLayout>

      <AddSpeechServiceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(service) => {
          queryClient.setQueryData<SpeechServiceDto[]>(speechKeys.list(), (current) => {
            if (!current) {
              return [service];
            }
            if (current.some((item) => item.id === service.id)) {
              return current.map((item) => (item.id === service.id ? service : item));
            }
            return [...current, service];
          });
          void queryClient.invalidateQueries({ queryKey: speechKeys.all });
          void navigate({
            to: "/speech/$speechServiceId",
            params: { speechServiceId: service.id },
          });
        }}
      />
    </SpeechContext.Provider>
  );
}
