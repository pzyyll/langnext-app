// ABOUTME: OCR feature layout with service list rail and nested editor outlet.
// ABOUTME: Loads OCR services via Query; URL-driven selection defaults to the first service.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { PageLayout } from "../../components/layouts/PageLayout";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { ocrKeys } from "../../query/keys";
import { ocrListOptions } from "../../query/options";
import { getIpcErrorMessage } from "../../storage/errors";
import type { OcrServiceDto } from "../../storage/types";
import { AddOcrServiceDialog } from "./AddOcrServiceDialog";
import { OcrContext } from "./OcrContext";

function providerBadgeKey(service: OcrServiceDto): "ocr.provider.baiduShort" | "ocr.provider.aiShort" {
  return service.providerType === "baidu" ? "ocr.provider.baiduShort" : "ocr.provider.aiShort";
}

export function OcrLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { ocrServiceId?: string };
  const selectedId = params.ocrServiceId;

  const servicesQuery = useQuery(ocrListOptions());
  const services = servicesQuery.data ?? [];
  const loading = servicesQuery.isLoading;
  const error =
    servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("ocr.loadFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);

  // When the OCR tab opens with services already configured but none selected,
  // default to the first service so the editor is immediately visible.
  useEffect(() => {
    if (loading || error) return;
    if (selectedId) return;
    if (services.length === 0) return;
    void navigate({
      to: "/ocr/$ocrServiceId",
      params: { ocrServiceId: services[0].id },
    });
  }, [services, loading, error, selectedId, navigate]);

  const contextValue = useMemo(() => ({ ready: true as const }), []);

  return (
    <OcrContext.Provider value={contextValue}>
      <PageLayout title={t("ocr.title")} contentClassName="overflow-hidden">
        <aside
          className="
            flex w-models-rail shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest
          "
          aria-label={t("ocr.services")}
        >
          <div className="flex h-12 shrink-0 items-center border-b border-outline bg-surface-container-low px-1">
            <span className="min-w-0 flex-1 truncate pl-1 text-label-sm font-bold tracking-wide text-on-surface uppercase">
              {t("ocr.services")}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {loading ? (
              <p className="p-2 text-body-tight text-neutral" aria-live="polite">
                {t("ocr.loading")}
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
              <p className="p-2 text-body-tight text-neutral">{t("ocr.emptyList")}</p>
            ) : null}

            {!loading && !error && services.length > 0 ? (
              <ul className="min-h-0 flex-1 list-none overflow-y-auto p-0" role="listbox" aria-label={t("ocr.services")}>
                {services.map((service) => {
                  const active = service.id === selectedId;
                  return (
                    <li key={service.id} role="option" aria-selected={active}>
                      <Link
                        to="/ocr/$ocrServiceId"
                        params={{ ocrServiceId: service.id }}
                        className={cn(
                          `
                            group flex items-center gap-1 border-l-4 p-2 text-left text-body-tight text-on-surface
                            transition-colors
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
                        <span className={cn("min-w-0 flex-1 truncate", active ? "font-bold" : "font-normal")}>
                          {service.displayName}
                        </span>
                        <Badge>{t(providerBadgeKey(service))}</Badge>
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
              aria-label={t("ocr.addAria")}
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

      <AddOcrServiceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(service) => {
          queryClient.setQueryData<OcrServiceDto[]>(ocrKeys.list(), (current) => {
            if (!current) {
              return [service];
            }
            if (current.some((item) => item.id === service.id)) {
              return current.map((item) => (item.id === service.id ? service : item));
            }
            return [...current, service];
          });
          void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
          void navigate({
            to: "/ocr/$ocrServiceId",
            params: { ocrServiceId: service.id },
          });
        }}
      />
    </OcrContext.Provider>
  );
}
