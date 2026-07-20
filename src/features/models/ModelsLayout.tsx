// ABOUTME: Models feature layout with provider sidebar and nested route outlet.
// ABOUTME: Loads provider instances via Query and coordinates sidebar animations.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/Badge";
import { PageLayout } from "../../components/layouts/PageLayout";
import { useToast } from "../../components/toast/useToast";
import { outlineButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { modelKeys, providerKeys } from "../../query/keys";
import { providerListOptions } from "../../query/options";
import { applyProviderReorderOrder, shouldRollbackReorder } from "../../query/reorderProvidersCache";
import { reorderProviderInstances } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderInstanceDto } from "../../storage/types";
import { ModelsContext } from "./ModelsContext";
import { AddProviderDialog } from "./AddProviderDialog";

/** Slightly longer than CSS channel-exit (120ms) so missing animationend never sticks. */
const CHANNEL_EXIT_FALLBACK_MS = 200;
/** Slightly longer than CSS channel-enter (150ms) to clear enter class. */
const CHANNEL_ENTER_FALLBACK_MS = 250;

type ExitingProviderEntry = {
  provider: ProviderInstanceDto;
  /** Visual index at exit start (includes other mid-exit rows). */
  index: number;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Merge live query rows with exiting snapshots at their captured visual indices. */
function mergeProvidersWithExiting(
  fromQuery: readonly ProviderInstanceDto[],
  exiting: ReadonlyMap<string, ExitingProviderEntry>,
): ProviderInstanceDto[] {
  const byId = new Map(fromQuery.map((item) => [item.id, item]));
  const list = fromQuery.slice();
  const orphans = [...exiting.entries()].filter(([id]) => !byId.has(id)).sort((a, b) => a[1].index - b[1].index);
  for (const [, { provider, index }] of orphans) {
    list.splice(Math.min(index, list.length), 0, provider);
  }
  return list;
}

function SortableChannelItem({
  provider,
  index,
  active,
  entering,
  exiting,
  reorderDisabled,
  onEnterComplete,
  onExitComplete,
}: {
  provider: ProviderInstanceDto;
  index: number;
  active: boolean;
  entering: boolean;
  exiting: boolean;
  /** True while a reorder mutation is in flight (serialize concurrent drags). */
  reorderDisabled: boolean;
  onEnterComplete: (id: string) => void;
  onExitComplete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { ref, handleRef } = useSortable({
    id: provider.id,
    index,
    disabled: exiting || reorderDisabled,
  });

  const exitDoneRef = useRef(false);
  const enterDoneRef = useRef(false);

  useEffect(() => {
    exitDoneRef.current = false;
    if (!exiting) return;

    const finish = () => {
      if (exitDoneRef.current) return;
      exitDoneRef.current = true;
      onExitComplete(provider.id);
    };

    // No animation event when reduced motion disables CSS animation.
    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const timer = window.setTimeout(finish, CHANNEL_EXIT_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [exiting, onExitComplete, provider.id]);

  useEffect(() => {
    enterDoneRef.current = false;
    if (!entering || exiting) return;

    const finish = () => {
      if (enterDoneRef.current) return;
      enterDoneRef.current = true;
      onEnterComplete(provider.id);
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const timer = window.setTimeout(finish, CHANNEL_ENTER_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [entering, exiting, onEnterComplete, provider.id]);

  const animationClass = exiting
    ? "animate-channel-exit motion-reduce:animate-none"
    : entering
      ? "animate-channel-enter motion-reduce:animate-none"
      : "";

  return (
    <li ref={ref} role="option" aria-selected={active}>
      <div
        className={cn(
          "group flex items-center gap-0.5 border-l-4 py-1.5 pr-1 pl-0.5 transition-colors",
          animationClass,
          active ? "border-tertiary bg-surface-container-low" : "border-transparent hover:bg-surface-container-highest",
          exiting && "pointer-events-none",
        )}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          const name = event.animationName;
          if (exiting && name.includes("channel-exit")) {
            if (exitDoneRef.current) return;
            exitDoneRef.current = true;
            onExitComplete(provider.id);
            return;
          }
          if (entering && !exiting && name.includes("channel-enter")) {
            if (enterDoneRef.current) return;
            enterDoneRef.current = true;
            onEnterComplete(provider.id);
          }
        }}
      >
        <button
          ref={handleRef}
          type="button"
          aria-label={t("models.reorderAria", { name: provider.displayName })}
          disabled={exiting || reorderDisabled}
          className={cn(
            "w-5 shrink-0 cursor-grab text-center text-[10px] leading-none text-neutral active:cursor-grabbing",
            active ? "text-on-surface" : "group-hover:text-on-surface",
            (exiting || reorderDisabled) && "cursor-default opacity-40",
          )}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
        <Link
          draggable={false}
          to="/models/$providerId"
          params={{ providerId: provider.id }}
          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-body-tight text-on-surface"
          title={provider.displayName}
        >
          <span className={cn("min-w-0 flex-1 truncate", active ? "font-bold" : "font-normal")}>
            {provider.displayName}
          </span>
          {provider.enabled ? <Badge tone="accent">{t("common.on")}</Badge> : null}
        </Link>
      </div>
    </li>
  );
}

export function ModelsLayout() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { providerId?: string };
  const selectedId = params.providerId;

  const providersQuery = useQuery(providerListOptions());
  const providersLoading = providersQuery.isLoading;
  const providersError =
    providersQuery.error != null ? getIpcErrorMessage(providersQuery.error, t("models.loadChannelsFailed")) : null;

  const [addOpen, setAddOpen] = useState(false);
  /** Snapshots + visual index so exit animation plays in-place (not at list end). */
  const [exitingProviders, setExitingProviders] = useState<Map<string, ExitingProviderEntry>>(() => new Map());
  /** Mirror updated only in exit callbacks (not during render) for sync index capture. */
  const exitingProvidersRef = useRef(exitingProviders);
  /** IDs inserted via create; play enter animation. */
  const [enteringProviderIds, setEnteringProviderIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Monotonic epoch so a stale reorder error cannot roll back a newer order. */
  const reorderEpochRef = useRef(0);

  // Merge query data with exiting snapshots at their captured visual indices.
  const providers = useMemo(
    () => mergeProvidersWithExiting(providersQuery.data ?? [], exitingProviders),
    [providersQuery.data, exitingProviders],
  );

  const exitingProviderIds = useMemo(() => new Set(exitingProviders.keys()), [exitingProviders]);

  // When the Models tab opens with channels already configured but none selected,
  // default to the first non-exiting channel so the editor is immediately visible.
  useEffect(() => {
    if (providersLoading || providersError) return;
    if (selectedId) return;
    if (providers.length === 0) return;
    const first = providers.find((item) => !exitingProviderIds.has(item.id));
    if (!first) return;
    void navigate({
      to: "/models/$providerId",
      params: { providerId: first.id },
    });
  }, [providers, providersLoading, providersError, selectedId, navigate, exitingProviderIds]);

  const markProviderEnter = useCallback((id: string) => {
    setEnteringProviderIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const beginProviderExit = useCallback(
    (provider: ProviderInstanceDto) => {
      const currentExiting = exitingProvidersRef.current;
      if (currentExiting.has(provider.id)) {
        return;
      }
      // Capture visual index synchronously before optimistic cache removal.
      const fromQuery = queryClient.getQueryData<ProviderInstanceDto[]>(providerKeys.list()) ?? [];
      const display = mergeProvidersWithExiting(fromQuery, currentExiting);
      const index = display.findIndex((item) => item.id === provider.id);
      const nextExiting = new Map(currentExiting);
      nextExiting.set(provider.id, {
        provider,
        index: index >= 0 ? index : display.length,
      });
      exitingProvidersRef.current = nextExiting;
      setExitingProviders(nextExiting);

      // Drop from cache immediately so the row is driven only by the exiting snapshot.
      queryClient.setQueryData<ProviderInstanceDto[]>(providerKeys.list(), (previous) => {
        if (!previous) return previous;
        const next = previous.filter((item) => item.id !== provider.id);
        return next.length === previous.length ? previous : next;
      });
      setEnteringProviderIds((current) => {
        if (!current.has(provider.id)) return current;
        const next = new Set(current);
        next.delete(provider.id);
        return next;
      });
    },
    [queryClient],
  );

  const finalizeRemoveProvider = useCallback((id: string) => {
    const currentExiting = exitingProvidersRef.current;
    if (currentExiting.has(id)) {
      const nextExiting = new Map(currentExiting);
      nextExiting.delete(id);
      exitingProvidersRef.current = nextExiting;
      setExitingProviders(nextExiting);
    }
    setEnteringProviderIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const clearEnteringProvider = useCallback((id: string) => {
    setEnteringProviderIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => reorderProviderInstances(orderedIds),
    onMutate: async (orderedIds) => {
      const epoch = ++reorderEpochRef.current;
      await queryClient.cancelQueries({ queryKey: providerKeys.list() });
      const previous = queryClient.getQueryData<ProviderInstanceDto[]>(providerKeys.list());
      if (previous) {
        const next = applyProviderReorderOrder(previous, orderedIds);
        if (next) {
          queryClient.setQueryData(providerKeys.list(), next);
        }
      }
      return { previous, epoch };
    },
    onError: (error, _ids, context) => {
      // Only roll back if this failure is still the latest mutation epoch.
      if (context?.previous && context.epoch != null && shouldRollbackReorder(context.epoch, reorderEpochRef.current)) {
        queryClient.setQueryData(providerKeys.list(), context.previous);
      }
      const message = getIpcErrorMessage(error, t("models.reorderChannelsFailed"));
      toast.error({ title: t("models.reorderChannelsFailed"), description: message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    },
  });

  const reorderPending = reorderMutation.isPending;
  const displayError = providersError;

  const contextValue = useMemo(
    () => ({
      markProviderEnter,
      beginProviderExit,
    }),
    [markProviderEnter, beginProviderExit],
  );

  return (
    <ModelsContext.Provider value={contextValue}>
      <PageLayout title={t("models.title")} contentClassName="overflow-hidden">
        <aside
          className="flex w-models-rail shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest"
          aria-label={t("models.channels")}
        >
          <div className="flex h-12 shrink-0 items-center border-b border-outline bg-surface-container-low px-1">
            <span className="min-w-0 flex-1 truncate pl-1 text-label-sm font-bold tracking-wide text-on-surface uppercase">
              {t("models.channels")}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {providersLoading ? (
              <p className="px-2 py-2 text-body-tight text-neutral" aria-live="polite">
                {t("models.loadingChannels")}
              </p>
            ) : null}

            {displayError ? (
              <div className="flex flex-col gap-2 px-2 py-2" role="alert">
                <p className="text-body-tight text-error">{displayError}</p>
                <Button
                  type="button"
                  className={outlineButtonClassName}
                  onClick={() => {
                    void providersQuery.refetch();
                  }}
                >
                  {t("common.retry")}
                </Button>
              </div>
            ) : null}

            {!providersLoading && !displayError && providers.length === 0 ? (
              <p className="px-2 py-2 text-body-tight text-neutral">{t("models.emptyChannels")}</p>
            ) : null}

            {!providersLoading && !displayError && providers.length > 0 ? (
              <DragDropProvider
                onDragEnd={(event) => {
                  if (event.canceled) return;
                  // Serialize reorders: concurrent mutates race optimistic cache + rollback.
                  if (reorderMutation.isPending) return;

                  const { source } = event.operation;
                  if (!isSortable(source)) return;

                  const { initialIndex, index } = source;
                  if (initialIndex === index) return;

                  const next = providers.slice();
                  const [removed] = next.splice(initialIndex, 1);
                  if (!removed) return;
                  next.splice(index, 0, removed);
                  // Exiting IDs are already deleted server-side; including them yields NotFound.
                  const persistIds = next.map((item) => item.id).filter((id) => !exitingProviderIds.has(id));
                  if (persistIds.length === 0) {
                    return;
                  }
                  reorderMutation.mutate(persistIds);
                }}
              >
                <ul
                  className="min-h-0 flex-1 list-none overflow-y-auto p-0"
                  role="listbox"
                  aria-label={t("models.channels")}
                >
                  {providers.map((provider, index) => (
                    <SortableChannelItem
                      key={provider.id}
                      provider={provider}
                      index={index}
                      active={provider.id === selectedId}
                      entering={enteringProviderIds.has(provider.id)}
                      exiting={exitingProviderIds.has(provider.id)}
                      reorderDisabled={reorderPending}
                      onEnterComplete={clearEnteringProvider}
                      onExitComplete={finalizeRemoveProvider}
                    />
                  ))}
                </ul>
              </DragDropProvider>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-outline p-gutter">
            <Button
              type="button"
              className={`${outlineButtonClassName} w-full bg-surface-2 hover:not-data-disabled:bg-surface-3`}
              aria-label={t("models.addChannelAria")}
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

      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(provider) => {
          markProviderEnter(provider.id);
          queryClient.setQueryData<ProviderInstanceDto[]>(providerKeys.list(), (current) => {
            if (!current) {
              return [provider];
            }
            if (current.some((item) => item.id === provider.id)) {
              return current.map((item) => (item.id === provider.id ? provider : item));
            }
            return [...current, provider];
          });
          void queryClient.invalidateQueries({ queryKey: providerKeys.all });
          void queryClient.invalidateQueries({ queryKey: modelKeys.all });
          void navigate({
            to: "/models/$providerId",
            params: { providerId: provider.id },
          });
        }}
      />
    </ModelsContext.Provider>
  );
}
