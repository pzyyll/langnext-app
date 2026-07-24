// ABOUTME: OCR feature layout with service list rail, nested editor outlet, and header tools.
// ABOUTME: Loads OCR services via Query; URL selection + screenshot default OCR picker.
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
import { ocrKeys, settingsKeys } from "../../query/keys";
import { appSettingsOptions, ocrListOptions } from "../../query/options";
import { setAppDefaultOcrService } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { AppSettingsDto, OcrServiceDto } from "../../storage/types";
import { AddOcrServiceDialog } from "./AddOcrServiceDialog";
import { OcrContext } from "./OcrContext";
import { getOcrProviderOption } from "./ocrProviderOptions";

/** Select value representing no default screenshot OCR service. */
const NO_DEFAULT_OCR_SERVICE_VALUE = "";
/** Compact select width for the page-header toolbar control. */
const SCREENSHOT_OCR_SELECT_WIDTH_CLASS = "w-48";

export function OcrLayout() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { ocrServiceId?: string };
  const selectedId = params.ocrServiceId;

  const servicesQuery = useQuery(ocrListOptions());
  const settingsQuery = useQuery(appSettingsOptions());
  const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
  const loading = servicesQuery.isLoading;
  const error = servicesQuery.error != null ? getIpcErrorMessage(servicesQuery.error, t("ocr.loadFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);

  const defaultOcrServiceId = settingsQuery.data?.defaultOcrServiceId ?? null;

  const screenshotOcrOptions = useMemo(
    () => [
      { value: NO_DEFAULT_OCR_SERVICE_VALUE, label: t("ocr.screenshotDefault.none") },
      ...services.map((service) => ({
        value: service.id,
        label: service.displayName,
      })),
    ],
    [services, t],
  );

  const screenshotOcrExtraOptions = useMemo(() => {
    if (!defaultOcrServiceId) return undefined;
    if (services.some((service) => service.id === defaultOcrServiceId)) return undefined;
    return [{ value: defaultOcrServiceId, label: t("ocr.screenshotDefault.missing") }];
  }, [defaultOcrServiceId, services, t]);

  const setDefaultOcrMutation = useMutation({
    mutationFn: (nextId: string | null) => setAppDefaultOcrService(nextId),
    onSuccess: (settings) => {
      queryClient.setQueryData<AppSettingsDto>(settingsKeys.detail(), settings);
    },
    onError: (mutationError) => {
      const message = getIpcErrorMessage(mutationError, t("ocr.toast.screenshotDefaultFailed"));
      toast.error({ title: t("ocr.toast.screenshotDefaultFailed"), description: message });
    },
  });

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

  const screenshotDefaultSelectId = "ocr-screenshot-default";
  const screenshotSelectDisabled = setDefaultOcrMutation.isPending || settingsQuery.isLoading || services.length === 0;

  return (
    <OcrContext.Provider value={contextValue}>
      <PageLayout
        title={t("ocr.title")}
        contentClassName="overflow-hidden"
        actions={
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor={screenshotDefaultSelectId} className="shrink-0 text-label-sm text-neutral uppercase">
              {t("ocr.screenshotDefault.label")}
            </label>
            <SelectField
              id={screenshotDefaultSelectId}
              compact
              className={SCREENSHOT_OCR_SELECT_WIDTH_CLASS}
              value={defaultOcrServiceId ?? NO_DEFAULT_OCR_SERVICE_VALUE}
              onValueChange={(value) => {
                const nextId = !value || value === NO_DEFAULT_OCR_SERVICE_VALUE ? null : value;
                if (nextId === defaultOcrServiceId) return;
                setDefaultOcrMutation.mutate(nextId);
              }}
              options={screenshotOcrOptions}
              extraOptions={screenshotOcrExtraOptions}
              disabled={screenshotSelectDisabled}
              placeholder={services.length === 0 ? t("ocr.screenshotDefault.empty") : undefined}
              aria-label={t("ocr.screenshotDefault.aria")}
            />
          </div>
        }
      >
        <aside
          className="
            flex w-models-rail shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest
          "
          aria-label={t("ocr.services")}
        >
          <ConfigRailHeader>{t("ocr.services")}</ConfigRailHeader>

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
              <ul
                className="min-h-0 flex-1 list-none overflow-y-auto p-0"
                role="listbox"
                aria-label={t("ocr.services")}
              >
                {services.map((service) => {
                  const active = service.id === selectedId;
                  const provider = getOcrProviderOption(service.providerType);
                  const ProviderIcon = provider.Icon;
                  const providerLabel = t(provider.labelKey);
                  return (
                    <li key={service.id} role="option" aria-selected={active}>
                      <Link
                        to="/ocr/$ocrServiceId"
                        params={{ ocrServiceId: service.id }}
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
                        <span className={cn("min-w-0 flex-1 truncate", active ? "font-bold" : "font-normal")}>
                          {service.displayName}
                        </span>
                        <span className="inline-flex shrink-0" title={providerLabel}>
                          <ProviderIcon className="size-4" aria-label={providerLabel} />
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
