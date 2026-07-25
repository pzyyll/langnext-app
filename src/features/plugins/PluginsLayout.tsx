// ABOUTME: Plugins feature layout with instance rail, nested editor outlet, and create dialog.
// ABOUTME: Loads sanitized plugin instances via Query; URL selection drives the editor.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { ConfigRailHeader } from "../../components/layouts/ConfigRailHeader";
import { PageLayout } from "../../components/layouts/PageLayout";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { integrationKeys } from "../../query/keys";
import { integrationListOptions } from "../../query/options";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto } from "../../storage/types";
import { EDGE_TTS_PLUGIN_ID, GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_TRANSLATE_WEB_PLUGIN_ID } from "../../storage/types";
import { AddIntegrationDialog } from "./AddIntegrationDialog";

/** Shared rail footer: fixed border-box block size so rail matches profiles layout. */
const panelFooterClassName =
  "box-border flex h-[calc(2rem+2rem+1px)] max-h-[calc(2rem+2rem+1px)] min-h-[calc(2rem+2rem+1px)] shrink-0 grow-0 items-center border-t border-line px-8 py-4";

const newInstanceButtonClassName = `${outlineButtonClassName} w-full font-bold hover:not-data-disabled:bg-on-surface`;

export function PluginsLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { integrationInstanceId?: string };
  const selectedId = params.integrationInstanceId;

  const instancesQuery = useQuery(integrationListOptions());
  const instances = useMemo(() => instancesQuery.data ?? [], [instancesQuery.data]);
  const loading = instancesQuery.isLoading;
  const error = instancesQuery.error != null ? getIpcErrorMessage(instancesQuery.error, t("plugins.loadFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (loading || error) return;
    if (selectedId) return;
    if (instances.length === 0) return;
    void navigate({
      to: "/plugins/$integrationInstanceId",
      params: { integrationInstanceId: instances[0].id },
    });
  }, [instances, loading, error, selectedId, navigate]);

  function pluginLabel(instance: IntegrationInstanceDto): string {
    if (instance.pluginId === GOOGLE_CLOUD_PLUGIN_ID) {
      return t("plugins.googleCloud.name");
    }
    if (instance.pluginId === GOOGLE_TRANSLATE_WEB_PLUGIN_ID) {
      return t("plugins.googleTranslateWeb.name");
    }
    if (instance.pluginId === EDGE_TTS_PLUGIN_ID) {
      return t("plugins.edgeTts.name");
    }
    return instance.pluginId;
  }

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
              <Button
                type="button"
                className={outlineButtonClassName}
                onClick={() => {
                  void instancesQuery.refetch();
                }}
              >
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
                      <div className="truncate text-code-inline text-neutral">{pluginLabel(instance)}</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <div className={panelFooterClassName}>
          <Button
            type="button"
            className={newInstanceButtonClassName}
            onClick={() => {
              setAddOpen(true);
            }}
          >
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
