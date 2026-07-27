// ABOUTME: Plugins feature layout with instance rail, schema-backed labels, and create dialog.
// ABOUTME: Loads sanitized instances and registration definitions; URL selection drives the editor.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightCloud from "~icons/material-symbols-light/cloud";
import IconMaterialSymbolsLightExtensionOutline from "~icons/material-symbols-light/extension-outline";
import IconMaterialSymbolsLightRecordVoiceOverOutline from "~icons/material-symbols-light/record-voice-over-outline";
import IconMaterialSymbolsLightTranslate from "~icons/material-symbols-light/translate";
import { Badge } from "../../components/Badge";
import { ConfigRailHeader } from "../../components/layouts/ConfigRailHeader";
import { PageLayout } from "../../components/layouts/PageLayout";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { integrationKeys } from "../../query/keys";
import { integrationDefinitionListOptions, integrationListOptions } from "../../query/options";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";
import { resolvePluginDisplayName, resolvePluginIcon, type PluginTextLookup } from "./pluginPresentation";
import { AddIntegrationDialog } from "./AddIntegrationDialog";

const panelFooterClassName =
  "box-border flex h-[calc(2rem+2rem+1px)] max-h-[calc(2rem+2rem+1px)] min-h-[calc(2rem+2rem+1px)] shrink-0 grow-0 items-center border-t border-line px-8 py-4";
const newInstanceButtonClassName = `${outlineButtonClassName} w-full font-bold hover:not-data-disabled:bg-on-surface`;

type PluginIconProps = {
  iconId: string | undefined;
};

function PluginIcon({ iconId }: PluginIconProps) {
  const resolved = resolvePluginIcon(iconId);
  const className = "size-4 shrink-0 text-neutral";
  switch (resolved) {
    case "google-cloud":
      return <IconMaterialSymbolsLightCloud className={className} aria-hidden />;
    case "google-translate-web":
      return <IconMaterialSymbolsLightTranslate className={className} aria-hidden />;
    case "edge-tts":
      return <IconMaterialSymbolsLightRecordVoiceOverOutline className={className} aria-hidden />;
    case "extension":
      return <IconMaterialSymbolsLightExtensionOutline className={className} aria-hidden />;
  }
}

function pluginLabel(
  instance: IntegrationInstanceDto,
  definitionsById: ReadonlyMap<string, ServiceIntegrationDefinitionDto>,
  translate: PluginTextLookup,
): string {
  const definition = definitionsById.get(instance.pluginId);
  return definition ? resolvePluginDisplayName(definition, translate) : instance.pluginId;
}

export function PluginsLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { integrationInstanceId?: string };
  const selectedId = params.integrationInstanceId;

  const instancesQuery = useQuery(integrationListOptions());
  const definitionsQuery = useQuery(integrationDefinitionListOptions());
  const instances = useMemo(() => instancesQuery.data ?? [], [instancesQuery.data]);
  const definitionsById = useMemo(
    () => new Map((definitionsQuery.data ?? []).map((definition) => [definition.id, definition])),
    [definitionsQuery.data],
  );
  const loading = instancesQuery.isLoading;
  const error = instancesQuery.error != null ? getIpcErrorMessage(instancesQuery.error, t("plugins.loadFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (loading || error || selectedId || instances.length === 0) {
      return;
    }
    void navigate({
      to: "/plugins/$integrationInstanceId",
      params: { integrationInstanceId: instances[0].id },
    });
  }, [instances, loading, error, selectedId, navigate]);

  return (
    <PageLayout title={t("plugins.title")} contentClassName="flex-col overflow-hidden lg:flex-row">
      <aside
        className="
          flex max-h-64 w-full shrink-0 flex-col border-b border-line bg-surface-2
          lg:max-h-none lg:w-64 lg:border-r lg:border-b-0
        "
        aria-label={t("plugins.instances")}
      >
        <ConfigRailHeader>{t("plugins.instances")}</ConfigRailHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {loading ? (
            <p className="text-body-tight text-neutral" aria-live="polite">
              {t("plugins.loading")}
            </p>
          ) : null}

          {error ? (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-body-tight text-error">{error}</p>
              <Button type="button" className={outlineButtonClassName} onClick={() => void instancesQuery.refetch()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}

          {!loading && !error && instances.length === 0 ? (
            <p className="text-body-tight text-neutral">{t("plugins.emptyList")}</p>
          ) : null}

          {!loading && !error && instances.length > 0 ? (
            <ul className="space-y-4">
              {instances.map((instance) => {
                const active = instance.id === selectedId;
                const definition = definitionsById.get(instance.pluginId);
                return (
                  <li key={instance.id}>
                    <Link
                      to="/plugins/$integrationInstanceId"
                      params={{ integrationInstanceId: instance.id }}
                      className={cn(
                        "block w-full rounded-none border border-line bg-surface p-3 text-left",
                        active ? "cursor-default" : "cursor-pointer",
                        active && "shadow-frame",
                        !active && "transition-colors",
                        !active && "hover:bg-surface-container",
                      )}
                      title={instance.displayName}
                    >
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <span className="truncate text-body-tight font-bold text-on-surface">
                          {instance.displayName}
                        </span>
                        {instance.enabled ? <Badge tone="accent">{t("common.enabled")}</Badge> : null}
                      </div>
                      <div className="flex min-w-0 items-center gap-1 text-code-inline text-neutral">
                        <PluginIcon iconId={definition?.presentation.icon} />
                        <span className="truncate">{pluginLabel(instance, definitionsById, t)}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <div className={panelFooterClassName}>
          <Button type="button" className={newInstanceButtonClassName} onClick={() => setAddOpen(true)}>
            + {t("plugins.createNew")}
          </Button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>

      <AddIntegrationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(instance) => {
          queryClient.setQueryData<IntegrationInstanceDto[]>(integrationKeys.list(), (current) => {
            if (!current) {
              return [instance];
            }
            if (current.some((item) => item.id === instance.id)) {
              return current.map((item) => (item.id === instance.id ? instance : item));
            }
            return [...current, instance];
          });
          void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
          void navigate({
            to: "/plugins/$integrationInstanceId",
            params: { integrationInstanceId: instance.id },
          });
        }}
      />
    </PageLayout>
  );
}
