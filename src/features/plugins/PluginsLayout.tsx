// ABOUTME: Integrations feature layout with instance rail, nested editor outlet, and create dialog.
// ABOUTME: Loads sanitized integration instances via Query; URL selection drives the editor.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { ConfigRailHeader } from "../../components/layouts/ConfigRailHeader";
import { PageLayout } from "../../components/layouts/PageLayout";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { integrationKeys } from "../../query/keys";
import { integrationListOptions } from "../../query/options";
import { getIpcErrorMessage } from "../../storage/errors";
import type { IntegrationInstanceDto } from "../../storage/types";
import { GOOGLE_CLOUD_PLUGIN_ID } from "../../storage/types";
import { AddIntegrationDialog } from "./AddIntegrationDialog";

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
    return instance.pluginId;
  }

  return (
    <PageLayout title={t("plugins.title")} contentClassName="overflow-hidden">
      <aside
        className="
          flex w-models-rail shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest
        "
        aria-label={t("plugins.instances")}
      >
        <ConfigRailHeader>{t("plugins.instances")}</ConfigRailHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {loading ? (
            <p className="p-2 text-body-tight text-neutral" aria-live="polite">
              {t("plugins.loading")}
            </p>
          ) : null}

          {error ? (
            <div className="flex flex-col gap-2 p-2" role="alert">
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
            <p className="p-2 text-body-tight text-neutral">{t("plugins.emptyList")}</p>
          ) : null}

          {!loading && !error && instances.length > 0 ? (
            <ul
              className="min-h-0 flex-1 list-none overflow-y-auto p-0"
              role="listbox"
              aria-label={t("plugins.instances")}
            >
              {instances.map((instance) => {
                const active = instance.id === selectedId;
                return (
                  <li key={instance.id} role="option" aria-selected={active}>
                    <Link
                      to="/plugins/$integrationInstanceId"
                      params={{ integrationInstanceId: instance.id }}
                      className={cn(
                        `
                          group flex items-center gap-1 border-l-4 px-2 py-1.5 text-left text-body-tight text-on-surface
                          transition-colors
                        `,
                        active
                          ? "border-tertiary bg-surface-container-low"
                          : `
                            border-transparent
                            hover:bg-surface-container-highest
                          `,
                        !instance.enabled && "opacity-60",
                      )}
                      title={instance.displayName}
                    >
                      <span className={cn("min-w-0 flex-1 truncate", active ? "font-bold" : "font-normal")}>
                        {instance.displayName}
                      </span>
                      <span className="shrink-0 text-[10px] tracking-wide text-neutral uppercase">
                        {pluginLabel(instance)}
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
            aria-label={t("plugins.addAria")}
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
