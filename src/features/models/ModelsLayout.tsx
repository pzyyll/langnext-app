// ABOUTME: Models feature layout with provider sidebar and nested route outlet.
// ABOUTME: Loads real provider instances and coordinates add-channel navigation.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { listProviderInstances } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderInstanceDto } from "../../storage/types";
import { outlineButtonClassName } from "../../components/ui";
import { ModelsContext } from "./ModelsContext";
import { AddProviderDialog } from "./AddProviderDialog";

/** Viewport minus titlebar (2rem) and main vertical padding (2rem). */
const LAYOUT_HEIGHT_CLASS = "h-[calc(100dvh-4rem)]";

export function ModelsLayout() {
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { providerId?: string };
	const selectedId = params.providerId;

	const [providers, setProviders] = useState<ProviderInstanceDto[]>([]);
	const [providersLoading, setProvidersLoading] = useState(true);
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);

	const refreshProviders = useCallback(async () => {
		setProvidersError(null);
		setProvidersLoading(true);
		try {
			const list = await listProviderInstances();
			setProviders(list);
		} catch (error: unknown) {
			setProvidersError(getIpcErrorMessage(error, "Failed to load channels."));
		} finally {
			setProvidersLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			setProvidersError(null);
			setProvidersLoading(true);
			try {
				const list = await listProviderInstances();
				if (!cancelled) {
					setProviders(list);
				}
			} catch (error: unknown) {
				if (!cancelled) {
					setProvidersError(getIpcErrorMessage(error, "Failed to load channels."));
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
	}, []);

	const upsertProvider = useCallback((provider: ProviderInstanceDto) => {
		setProviders((current) => {
			const index = current.findIndex((item) => item.id === provider.id);
			if (index < 0) {
				return [...current, provider];
			}
			const next = current.slice();
			next[index] = provider;
			return next;
		});
	}, []);

	const removeProvider = useCallback((id: string) => {
		setProviders((current) => current.filter((item) => item.id !== id));
	}, []);

	const contextValue = useMemo(
		() => ({
			providers,
			providersLoading,
			providersError,
			refreshProviders,
			upsertProvider,
			removeProvider,
		}),
		[providers, providersLoading, providersError, refreshProviders, upsertProvider, removeProvider],
	);

	return (
		<ModelsContext.Provider value={contextValue}>
			<div className={`shadow-frame flex min-h-0 ${LAYOUT_HEIGHT_CLASS} overflow-hidden border border-line bg-surface`}>
				<aside className="flex w-48 shrink-0 flex-col border-r border-line bg-surface">
					<div className="flex min-h-0 flex-1 flex-col p-4">
						<div className="shrink-0">
							<h2 className="text-xl font-bold text-ink">Channels</h2>
							<p className="mb-4 text-xs text-muted">API providers</p>
						</div>

						{providersLoading ? (
							<p className="text-sm text-muted" aria-live="polite">
								Loading channels…
							</p>
						) : null}

						{providersError ? (
							<div className="flex flex-col gap-2" role="alert">
								<p className="text-sm text-danger">{providersError}</p>
								<Button
									type="button"
									className={outlineButtonClassName}
									onClick={() => {
										void refreshProviders();
									}}
								>
									Retry
								</Button>
							</div>
						) : null}

						{!providersLoading && !providersError && providers.length === 0 ? (
							<p className="text-sm text-muted">No channels yet. Use + to add one.</p>
						) : null}

						{!providersLoading && !providersError && providers.length > 0 ? (
							<ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
								{providers.map((provider) => {
									const active = provider.id === selectedId;
									return (
										<li key={provider.id}>
											<Link
												to="/models/$providerId"
												params={{ providerId: provider.id }}
												className={
													active
														? "block rounded-none bg-surface-2 px-3 py-2 text-sm font-bold text-ink"
														: "block rounded-none px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
												}
											>
												{provider.displayName}
											</Link>
										</li>
									);
								})}
							</ul>
						) : null}
					</div>

					<div className="shrink-0 border-t border-line p-4">
						<Button
							type="button"
							className={`${outlineButtonClassName} w-full bg-surface-2 hover:not-data-disabled:bg-surface-3`}
							aria-label="Add channel"
							onClick={() => {
								setAddOpen(true);
							}}
						>
							<span className="text-xl leading-none">+</span>
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
