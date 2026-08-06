// ABOUTME: Host-owned model resource status, Download/Cancel actions, and bounded progress UI.
// ABOUTME: Renders generically from signed model descriptors; no plugin-ID branching.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { outlineButtonClassName, primaryButtonClassName } from "../../components/ui";
import { integrationKeys } from "../../query/keys";
import { pluginModelResourceListOptions } from "../../query/options";
import type { PluginModelDownloadProgress, PluginModelResourceDto } from "../../storage/types";
import { runCancelPluginModelDownload, runDownloadPluginModel } from "./pluginModelDownloadFlow";

export type PluginModelResourcesPanelProps = {
  instanceId: string;
  /** When false, the panel is hidden (non-native packages). */
  enabled?: boolean;
};

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) {
    return `${mib.toFixed(1)} MiB`;
  }
  return `${bytes} B`;
}

export function PluginModelResourcesPanel({ instanceId, enabled = true }: PluginModelResourcesPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    ...pluginModelResourceListOptions(instanceId),
    enabled: enabled && instanceId.length > 0,
    retry: false,
  });
  const [progressByModel, setProgressByModel] = useState<Record<string, PluginModelDownloadProgress | undefined>>({});
  const [operationByModel, setOperationByModel] = useState<Record<string, string | undefined>>({});

  const downloadMutation = useMutation({
    mutationFn: async (model: PluginModelResourceDto) => {
      return runDownloadPluginModel(
        { instanceId, modelId: model.modelId },
        {
          onProgress: (progress) => {
            setProgressByModel((prev) => ({ ...prev, [model.modelId]: progress }));
            if (progress.operationId) {
              setOperationByModel((prev) => ({ ...prev, [model.modelId]: progress.operationId }));
            }
          },
        },
      );
    },
    onSettled: async (_data, _error, model) => {
      setOperationByModel((prev) => ({ ...prev, [model.modelId]: undefined }));
      // Always refresh after success, failure, or cancel so failed/missing status is visible.
      await queryClient.invalidateQueries({ queryKey: integrationKeys.modelResources(instanceId) });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (model: PluginModelResourceDto) => {
      const operationId = operationByModel[model.modelId];
      if (!operationId) {
        return;
      }
      await runCancelPluginModelDownload({
        instanceId,
        modelId: model.modelId,
        operationId,
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationKeys.modelResources(instanceId) });
    },
  });

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const hasModels = models.length > 0;
  const queryFailed = modelsQuery.isError;

  const body = useMemo(() => {
    if (!enabled) {
      return null;
    }
    if (modelsQuery.isLoading) {
      return <p className="text-sm text-muted-foreground">{t("plugins.models.loading")}</p>;
    }
    if (queryFailed) {
      // Non-native packages fail closed; hide the panel instead of noisy errors.
      return null;
    }
    if (!hasModels) {
      return null;
    }
    return (
      <ul className="flex flex-col gap-3">
        {models.map((model) => {
          const progress = progressByModel[model.modelId];
          const downloading =
            model.status === "downloading" ||
            downloadMutation.isPending ||
            progress?.phase === "downloading" ||
            progress?.phase === "starting" ||
            progress?.phase === "verifying" ||
            progress?.phase === "installing";
          const percent =
            progress && progress.totalBytes > 0
              ? Math.min(100, Math.round((progress.bytesDownloaded / progress.totalBytes) * 100))
              : null;
          return (
            <li key={model.modelId} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{model.modelId}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("plugins.models.versionSize", {
                      version: model.version,
                      size: formatBytes(model.installedBytes ?? model.expectedDownloadBytes),
                    })}
                  </div>
                  <div className="text-xs text-muted-foreground">{model.licenseLabel}</div>
                </div>
                <div className="flex items-center gap-2">
                  {model.status === "ready" ? (
                    <span className="text-xs text-muted-foreground">{t("plugins.models.ready")}</span>
                  ) : null}
                  {model.status === "failed" ? (
                    <span className="text-xs text-error">
                      {t("plugins.models.failed", { code: model.errorCode ?? "model_failed" })}
                    </span>
                  ) : null}
                  {model.status === "missing" || model.status === "failed" ? (
                    <Button
                      className={primaryButtonClassName}
                      disabled={downloading}
                      onClick={() => downloadMutation.mutate(model)}
                    >
                      {model.status === "failed" ? t("plugins.models.retry") : t("plugins.models.download")}
                    </Button>
                  ) : null}
                  {downloading ? (
                    <Button
                      className={outlineButtonClassName}
                      disabled={cancelMutation.isPending || !operationByModel[model.modelId]}
                      onClick={() => cancelMutation.mutate(model)}
                    >
                      {t("plugins.models.cancel")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {percent !== null ? (
                <div className="flex flex-col gap-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-sm bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("plugins.models.progress", {
                      percent,
                      phase: progress?.phase ?? "downloading",
                    })}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }, [
    cancelMutation,
    downloadMutation,
    enabled,
    hasModels,
    models,
    modelsQuery.isLoading,
    operationByModel,
    progressByModel,
    queryFailed,
    t,
  ]);

  if (!enabled || body === null) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{t("plugins.models.title")}</h3>
      {body}
    </section>
  );
}
