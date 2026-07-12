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
import { useToast } from "../../components/toast/useToast";
import { outlineButtonClassName } from "../../components/ui";
import { modelKeys, providerKeys } from "../../query/keys";
import { providerListOptions } from "../../query/options";
import { applyProviderReorderOrder, shouldRollbackReorder } from "../../query/reorderProvidersCache";
import { reorderProviderInstances } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderInstanceDto } from "../../storage/types";
import { ModelsContext } from "./ModelsContext";
import { AddProviderDialog } from "./AddProviderDialog";

/** Viewport minus titlebar-height and main vertical padding (2 × gutter). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-var(--spacing-titlebar-height)-2*var(--spacing-gutter))]";

/** Slightly longer than CSS channel-exit (120ms) so missing animationend never sticks. */
const CHANNEL_EXIT_FALLBACK_MS = 200;
/** Slightly longer than CSS channel-enter (150ms) to clear enter class. */
const CHANNEL_ENTER_FALLBACK_MS = 250;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

	// Row-level surface so drag handle + link share hover / selected chrome.
	const rowClass = active
		? `group flex bg-surface-2${exiting ? " pointer-events-none" : ""}`
		: `group flex hover:bg-surface-2${exiting ? " pointer-events-none" : ""}`;

	const handleClass = active
		? "w-6 shrink-0 cursor-grab text-on-surface active:cursor-grabbing"
		: "w-6 shrink-0 cursor-grab text-neutral group-hover:text-on-surface active:cursor-grabbing";

	const linkClass = active
		? `flex min-w-0 flex-1 items-center gap-2 rounded-none px-3 py-2 text-body-tight font-bold text-on-surface ${animationClass}`
		: `flex min-w-0 flex-1 items-center gap-2 rounded-none px-3 py-2 text-body-tight text-neutral group-hover:text-on-surface ${animationClass}`;

	return (
		<li ref={ref} className={rowClass}>
			<button
				ref={handleRef}
				type="button"
				aria-label={t("models.reorderAria", { name: provider.displayName })}
				className={handleClass}
			>
				<span aria-hidden="true">⋮⋮</span>
			</button>
			<Link
				draggable={false}
				to="/models/$providerId"
				params={{ providerId: provider.id }}
				className={linkClass}
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
				<span className="min-w-0 flex-1 truncate">{provider.displayName}</span>
				{provider.enabled ? <Badge tone="accent">{t("common.on")}</Badge> : null}
			</Link>
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
	/** Snapshots of providers leaving the list so exit animation can finish. */
	const [exitingProviders, setExitingProviders] = useState<Map<string, ProviderInstanceDto>>(() => new Map());
	/** IDs inserted via create; play enter animation. */
	const [enteringProviderIds, setEnteringProviderIds] = useState<ReadonlySet<string>>(() => new Set());
	/** Monotonic epoch so a stale reorder error cannot roll back a newer order. */
	const reorderEpochRef = useRef(0);

	// Merge query data with exiting snapshots (records no longer in cache).
	const providers = useMemo(() => {
		const fromQuery = providersQuery.data ?? [];
		const byId = new Map(fromQuery.map((item) => [item.id, item]));
		const list = fromQuery.slice();
		for (const [id, snapshot] of exitingProviders) {
			if (!byId.has(id)) {
				list.push(snapshot);
			}
		}
		return list;
	}, [providersQuery.data, exitingProviders]);

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

	const beginProviderExit = useCallback((provider: ProviderInstanceDto) => {
		setExitingProviders((current) => {
			if (current.has(provider.id)) return current;
			const next = new Map(current);
			next.set(provider.id, provider);
			return next;
		});
		setEnteringProviderIds((current) => {
			if (!current.has(provider.id)) return current;
			const next = new Set(current);
			next.delete(provider.id);
			return next;
		});
	}, []);

	const finalizeRemoveProvider = useCallback((id: string) => {
		setExitingProviders((current) => {
			if (!current.has(id)) return current;
			const next = new Map(current);
			next.delete(id);
			return next;
		});
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
			<div className={`shadow-frame flex min-h-0 ${LAYOUT_HEIGHT_CLASS} overflow-hidden border border-line bg-surface`}>
				<aside className="flex w-models-rail shrink-0 flex-col border-r border-line bg-surface">
					<div className="flex min-h-0 flex-1 flex-col p-gutter">
						<div className="mb-4 shrink-0">
							<h2 className="text-headline-sm font-bold text-on-surface">{t("models.channels")}</h2>
						</div>

						{providersLoading ? (
							<p className="text-body-tight text-neutral" aria-live="polite">
								{t("models.loadingChannels")}
							</p>
						) : null}

						{displayError ? (
							<div className="flex flex-col gap-2" role="alert">
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
							<p className="text-body-tight text-neutral">{t("models.emptyChannels")}</p>
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
								<ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
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

					<div className="shrink-0 border-t border-line p-gutter">
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
			</div>

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
