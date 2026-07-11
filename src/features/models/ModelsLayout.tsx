// ABOUTME: Models feature layout with provider sidebar and nested route outlet.
// ABOUTME: Loads real provider instances and coordinates add-channel navigation.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useTranslation } from "react-i18next";
import { listProviderInstances, reorderProviderInstances } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderInstanceDto } from "../../storage/types";
import { outlineButtonClassName } from "../../components/ui";
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
	onEnterComplete,
	onExitComplete,
}: {
	provider: ProviderInstanceDto;
	index: number;
	active: boolean;
	entering: boolean;
	exiting: boolean;
	onEnterComplete: (id: string) => void;
	onExitComplete: (id: string) => void;
}) {
	const { t } = useTranslation();
	const { ref, handleRef } = useSortable({
		id: provider.id,
		index,
		disabled: exiting,
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

	const linkClass = active
		? `block min-w-0 flex-1 rounded-none bg-surface-2 px-3 py-2 text-body-tight font-bold text-on-surface ${animationClass}`
		: `block min-w-0 flex-1 rounded-none px-3 py-2 text-body-tight text-neutral hover:bg-surface-2 hover:text-on-surface ${animationClass}`;

	return (
		<li ref={ref} className={exiting ? "pointer-events-none flex" : "flex"}>
			<button
				ref={handleRef}
				type="button"
				aria-label={t("models.reorderAria", { name: provider.displayName })}
				className="w-6 shrink-0 cursor-grab text-neutral hover:bg-surface-2 hover:text-on-surface active:cursor-grabbing"
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
				{provider.displayName}
			</Link>
		</li>
	);
}

export function ModelsLayout() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { providerId?: string };
	const selectedId = params.providerId;

	const [providers, setProviders] = useState<ProviderInstanceDto[]>([]);
	const knownProviderIdsRef = useRef<Set<string>>(new Set());
	const [providersLoading, setProvidersLoading] = useState(true);
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	/** IDs playing exit animation; still present in `providers` until finalized. */
	const [exitingProviderIds, setExitingProviderIds] = useState<ReadonlySet<string>>(() => new Set());
	/** IDs inserted via upsert (not initial load / refresh); play enter animation. */
	const [enteringProviderIds, setEnteringProviderIds] = useState<ReadonlySet<string>>(() => new Set());

	const refreshProviders = useCallback(async () => {
		setProvidersError(null);
		setProvidersLoading(true);
		try {
			const list = await listProviderInstances();
			knownProviderIdsRef.current = new Set(list.map((provider) => provider.id));
			setProviders(list);
			setExitingProviderIds(new Set());
			setEnteringProviderIds(new Set());
		} catch (error: unknown) {
			setProvidersError(getIpcErrorMessage(error, t("models.loadChannelsFailed")));
		} finally {
			setProvidersLoading(false);
		}
	}, [t]);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			setProvidersError(null);
			setProvidersLoading(true);
			try {
				const list = await listProviderInstances();
				if (!cancelled) {
					// Initial hydration uses setProviders only — no enter animation.
					knownProviderIdsRef.current = new Set(list.map((provider) => provider.id));
					setProviders(list);
				}
			} catch (error: unknown) {
				if (!cancelled) {
					setProvidersError(getIpcErrorMessage(error, t("models.loadChannelsFailed")));
				}
			} finally {
				if (!cancelled) {
					setProvidersLoading(false);
				}
			}
		}

		void load();
		return () => {
			cancelled = true;
		};
	}, [t]);

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

	const upsertProvider = useCallback((provider: ProviderInstanceDto) => {
		const isInsert = !knownProviderIdsRef.current.has(provider.id);
		knownProviderIdsRef.current.add(provider.id);
		setProviders((current) => {
			const index = current.findIndex((item) => item.id === provider.id);
			if (index < 0) {
				return [...current, provider];
			}
			const next = current.slice();
			next[index] = provider;
			return next;
		});
		// Only brand-new inserts (Add channel) get enter animation — not updates or initial load.
		if (isInsert) {
			setEnteringProviderIds((current) => {
				if (current.has(provider.id)) return current;
				const next = new Set(current);
				next.add(provider.id);
				return next;
			});
		}
	}, []);

	/** Marks a provider as exiting; list item stays until animation/fallback completes. */
	const removeProvider = useCallback((id: string) => {
		setExitingProviderIds((current) => {
			if (current.has(id)) return current;
			const next = new Set(current);
			next.add(id);
			return next;
		});
		setEnteringProviderIds((current) => {
			if (!current.has(id)) return current;
			const next = new Set(current);
			next.delete(id);
			return next;
		});
	}, []);

	const finalizeRemoveProvider = useCallback((id: string) => {
		knownProviderIdsRef.current.delete(id);
		setProviders((current) => current.filter((item) => item.id !== id));
		setExitingProviderIds((current) => {
			if (!current.has(id)) return current;
			const next = new Set(current);
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

	const reorderProviders = useCallback(
		async (orderedIds: string[]) => {
			// Keep exiting rows in local order so the leave animation can finish in place.
			setProviders((current) => {
				const byId = new Map(current.map((item) => [item.id, item]));
				const next: ProviderInstanceDto[] = [];
				for (const id of orderedIds) {
					const item = byId.get(id);
					if (item) {
						next.push(item);
					}
				}
				return next.length === current.length ? next : current;
			});
			// Exiting IDs are already deleted server-side; including them yields NotFound.
			const persistIds = orderedIds.filter((id) => !exitingProviderIds.has(id));
			if (persistIds.length === 0) {
				return;
			}
			try {
				await reorderProviderInstances(persistIds);
			} catch (error: unknown) {
				setProvidersError(getIpcErrorMessage(error, t("models.reorderChannelsFailed")));
				await refreshProviders();
			}
		},
		[exitingProviderIds, refreshProviders, t],
	);

	const contextValue = useMemo(
		() => ({
			providers,
			providersLoading,
			providersError,
			refreshProviders,
			upsertProvider,
			removeProvider,
			reorderProviders,
		}),
		[providers, providersLoading, providersError, refreshProviders, upsertProvider, removeProvider, reorderProviders],
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

						{providersError ? (
							<div className="flex flex-col gap-2" role="alert">
								<p className="text-body-tight text-error">{providersError}</p>
								<Button
									type="button"
									className={outlineButtonClassName}
									onClick={() => {
										void refreshProviders();
									}}
								>
									{t("common.retry")}
								</Button>
							</div>
						) : null}

						{!providersLoading && !providersError && providers.length === 0 ? (
							<p className="text-body-tight text-neutral">{t("models.emptyChannels")}</p>
						) : null}

						{!providersLoading && !providersError && providers.length > 0 ? (
							<DragDropProvider
								onDragEnd={(event) => {
									if (event.canceled) return;

									const { source } = event.operation;
									if (!isSortable(source)) return;

									const { initialIndex, index } = source;
									if (initialIndex === index) return;

									const next = providers.slice();
									const [removed] = next.splice(initialIndex, 1);
									if (!removed) return;
									next.splice(index, 0, removed);
									void reorderProviders(next.map((item) => item.id));
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
					upsertProvider(provider);
					void navigate({
						to: "/models/$providerId",
						params: { providerId: provider.id },
					});
				}}
			/>
		</ModelsContext.Provider>
	);
}
