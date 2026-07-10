// ABOUTME: Selected provider editor for connection settings and model management.
// ABOUTME: Coordinates local form state with real provider and model storage IPC.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { checkboxClassName, inputClassName, outlineButtonClassName, primaryButtonClassName } from "../../components/ui";
import { listProviderModels, saveProviderInstance, setModelEnabled } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { CredentialUpdate, ProviderInstanceDto, ProviderModelDto } from "../../storage/types";
import { getAdapterLabel, getDefaultBaseUrl } from "./adapterOptions";
import { AddManualModelDialog } from "./AddManualModelDialog";
import { useModelsContext } from "./ModelsContext";
import { ModelsTable } from "./ModelsTable";

export type ProviderEditorProps = {
	providerId: string;
};

type CredentialAction = "keep" | "replace" | "clear";

/** True when URL is non-loopback HTTP and needs insecure-HTTP acknowledgment. */
function needsInsecureHttpAck(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:") {
			return false;
		}
		const host = url.hostname;
		if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
			return false;
		}
		return true;
	} catch {
		// Invalid URLs are left to backend validation.
		return false;
	}
}

function normalizeBaseUrl(value: string): string | null {
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

export function ProviderEditor({ providerId }: ProviderEditorProps) {
	const { providers, providersLoading, providersError, upsertProvider, refreshProviders } = useModelsContext();
	const provider = providers.find((item) => item.id === providerId) ?? null;

	if (providersLoading) {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<p className="text-sm text-muted" aria-live="polite">
					Loading channel…
				</p>
			</div>
		);
	}

	if (providersError) {
		return (
			<div className="flex flex-1 flex-col items-start gap-3 p-8">
				<p className="text-sm text-danger" role="alert">
					{providersError}
				</p>
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
		);
	}

	if (!provider) {
		return (
			<div className="flex flex-1 flex-col items-start gap-2 p-8">
				<h1 className="text-2xl font-bold text-ink">Channel not found</h1>
				<p className="text-sm text-muted">
					This channel may have been removed. Select another channel or create a new one.
				</p>
			</div>
		);
	}

	// Remount connection form when the selected channel changes so local state re-inits cleanly.
	return <ProviderEditorLoaded key={provider.id} provider={provider} upsertProvider={upsertProvider} />;
}

type ProviderEditorLoadedProps = {
	provider: ProviderInstanceDto;
	upsertProvider: (provider: ProviderInstanceDto) => void;
};

function ProviderEditorLoaded({ provider, upsertProvider }: ProviderEditorLoadedProps) {
	const [baseUrlOverride, setBaseUrlOverride] = useState(provider.baseUrlOverride ?? "");
	const [enabled, setEnabled] = useState(provider.enabled);
	const [token, setToken] = useState("");
	const [credentialAction, setCredentialAction] = useState<CredentialAction>("keep");
	const [insecureHttpAcknowledged, setInsecureHttpAcknowledged] = useState(false);

	const [savePending, setSavePending] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveSuccess, setSaveSuccess] = useState(false);

	const [models, setModels] = useState<ProviderModelDto[]>([]);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [pendingModelIds, setPendingModelIds] = useState<Set<string>>(() => new Set());
	const [modelMutationError, setModelMutationError] = useState<string | null>(null);
	const [addModelOpen, setAddModelOpen] = useState(false);

	const providerId = provider.id;

	const reloadModels = useCallback(async (id: string) => {
		setModelsError(null);
		setModelsLoading(true);
		try {
			const list = await listProviderModels(id);
			setModels(list);
		} catch (error: unknown) {
			setModelsError(getIpcErrorMessage(error, "Failed to load models."));
		} finally {
			setModelsLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function load(id: string) {
			setModelsError(null);
			setModelMutationError(null);
			setPendingModelIds(new Set());
			setModelsLoading(true);
			try {
				const list = await listProviderModels(id);
				if (!cancelled) {
					setModels(list);
				}
			} catch (error: unknown) {
				if (!cancelled) {
					setModelsError(getIpcErrorMessage(error, "Failed to load models."));
				}
			} finally {
				if (!cancelled) {
					setModelsLoading(false);
				}
			}
		}

		void load(providerId);
		return () => {
			cancelled = true;
		};
	}, [providerId]);

	const savedBaseUrl = provider.baseUrlOverride ?? null;
	const normalizedBaseUrl = normalizeBaseUrl(baseUrlOverride);
	const endpointChanged = normalizedBaseUrl !== savedBaseUrl;
	const requiresInsecureAck = normalizedBaseUrl !== null && needsInsecureHttpAck(normalizedBaseUrl);
	const endpointUnchangedInsecure =
		!endpointChanged && requiresInsecureAck && Boolean(provider.insecureHttpConfirmedAt);

	const credentialRequiresReplace = provider.hasCredential && endpointChanged && credentialAction === "keep";

	const buildCredential = useCallback((): CredentialUpdate => {
		if (provider.credentialKind === "none") {
			return { action: "clear" };
		}
		if (credentialAction === "clear") {
			return { action: "clear" };
		}
		if (credentialAction === "replace" && token.trim()) {
			return { action: "replace", value: token.trim() };
		}
		return { action: "keep" };
	}, [credentialAction, provider.credentialKind, token]);

	const formValid = useMemo(() => {
		if (credentialRequiresReplace) {
			return false;
		}
		if (credentialAction === "replace" && !token.trim()) {
			return false;
		}
		if (requiresInsecureAck && !endpointUnchangedInsecure && !insecureHttpAcknowledged) {
			return false;
		}
		return true;
	}, [
		credentialAction,
		credentialRequiresReplace,
		endpointUnchangedInsecure,
		insecureHttpAcknowledged,
		requiresInsecureAck,
		token,
	]);

	function resetConnectionForm() {
		setBaseUrlOverride(provider.baseUrlOverride ?? "");
		setEnabled(provider.enabled);
		setToken("");
		setCredentialAction("keep");
		setInsecureHttpAcknowledged(false);
		setSaveError(null);
		setSaveSuccess(false);
	}

	async function handleSave() {
		if (!formValid || savePending) {
			return;
		}

		let insecureHttpConfirmedAt: string | null = null;
		if (normalizedBaseUrl !== null && needsInsecureHttpAck(normalizedBaseUrl)) {
			if (!endpointChanged && provider.insecureHttpConfirmedAt) {
				insecureHttpConfirmedAt = provider.insecureHttpConfirmedAt;
			} else if (insecureHttpAcknowledged) {
				insecureHttpConfirmedAt = new Date().toISOString();
			}
		}

		const credential = buildCredential();

		setSavePending(true);
		setSaveError(null);
		setSaveSuccess(false);
		try {
			const saved = await saveProviderInstance({
				id: provider.id,
				adapterId: provider.adapterId,
				displayName: provider.displayName,
				baseUrlOverride: normalizedBaseUrl,
				credentialKind: provider.credentialKind,
				credential,
				enabled,
				proxyMode: provider.proxyMode,
				insecureHttpConfirmedAt,
			});
			upsertProvider(saved);
			setToken("");
			setCredentialAction("keep");
			setInsecureHttpAcknowledged(false);
			setBaseUrlOverride(saved.baseUrlOverride ?? "");
			setEnabled(saved.enabled);
			setSaveSuccess(true);
		} catch (error: unknown) {
			setSaveError(getIpcErrorMessage(error, "Failed to save channel."));
		} finally {
			setSavePending(false);
		}
	}

	async function handleModelEnabledChange(modelId: string, nextEnabled: boolean) {
		if (pendingModelIds.has(modelId)) {
			return;
		}

		const previous = models.find((model) => model.id === modelId);
		if (!previous) {
			return;
		}

		setModelMutationError(null);
		setPendingModelIds((current) => new Set(current).add(modelId));
		setModels((current) => current.map((model) => (model.id === modelId ? { ...model, enabled: nextEnabled } : model)));

		try {
			const updated = await setModelEnabled(modelId, nextEnabled);
			setModels((current) => current.map((model) => (model.id === modelId ? updated : model)));
		} catch (error: unknown) {
			setModels((current) => current.map((model) => (model.id === modelId ? previous : model)));
			setModelMutationError(getIpcErrorMessage(error, "Failed to update model."));
		} finally {
			setPendingModelIds((current) => {
				const next = new Set(current);
				next.delete(modelId);
				return next;
			});
		}
	}

	const defaultBaseUrl = getDefaultBaseUrl(provider.adapterId);
	const tokenDisabled = provider.credentialKind === "none" || credentialAction === "clear";
	const tokenPlaceholder =
		credentialAction === "clear"
			? "Token will be removed on save"
			: provider.hasCredential
				? "•••••••••••• (stored)"
				: "Enter API token";

	const credentialStatusText =
		provider.credentialKind === "none"
			? "No credential required"
			: provider.hasCredential
				? "Token stored securely"
				: "No token stored";

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto p-8">
				<header className="mb-8">
					<h1 className="mb-2 text-3xl font-bold text-ink">{provider.displayName}</h1>
					<hr className="mb-4 border-line" />
					<p className="text-sm text-muted">
						Configure this channel and choose the models available to the app.
						<span className="mt-1 block text-xs">API Type: {getAdapterLabel(provider.adapterId)}</span>
					</p>
				</header>

				<section className="shadow-frame relative mb-10 border border-line p-6">
					<h3 className="mb-6 text-xl font-bold text-ink">Connection</h3>
					<div className="flex flex-col items-start gap-6 lg:flex-row">
						<div className="w-full min-w-0 flex-1 space-y-6">
							<div>
								<label className="mb-1 block text-sm font-medium text-ink" htmlFor="provider-base-url">
									Base URL
								</label>
								<input
									id="provider-base-url"
									className={inputClassName}
									type="text"
									value={baseUrlOverride}
									onChange={(event) => {
										setBaseUrlOverride(event.currentTarget.value);
										setSaveSuccess(false);
										setInsecureHttpAcknowledged(false);
									}}
									placeholder={defaultBaseUrl ?? "https://…"}
									spellCheck={false}
									disabled={savePending}
								/>
								{defaultBaseUrl ? <p className="mt-1 text-xs text-muted">API Type default: {defaultBaseUrl}</p> : null}
							</div>

							<div>
								<label className="mb-1 block text-sm font-medium text-ink" htmlFor="provider-api-token">
									API Token
								</label>
								<input
									id="provider-api-token"
									className={`${inputClassName} tracking-widest`}
									type="password"
									value={token}
									onChange={(event) => {
										const value = event.currentTarget.value;
										setToken(value);
										setSaveSuccess(false);
										if (credentialAction === "clear") {
											return;
										}
										if (value.trim()) {
											setCredentialAction("replace");
										} else {
											setCredentialAction("keep");
										}
									}}
									placeholder={tokenPlaceholder}
									spellCheck={false}
									autoComplete="off"
									disabled={savePending || tokenDisabled}
								/>
								{provider.credentialKind !== "none" && provider.hasCredential ? (
									<div className="mt-2 flex flex-wrap gap-2">
										{credentialAction !== "clear" ? (
											<Button
												type="button"
												className={outlineButtonClassName}
												disabled={savePending}
												onClick={() => {
													setCredentialAction("clear");
													setToken("");
													setSaveSuccess(false);
												}}
											>
												Remove stored token
											</Button>
										) : (
											<Button
												type="button"
												className={outlineButtonClassName}
												disabled={savePending}
												onClick={() => {
													setCredentialAction("keep");
													setToken("");
													setSaveSuccess(false);
												}}
											>
												Keep stored token
											</Button>
										)}
									</div>
								) : null}
								{credentialRequiresReplace ? (
									<p className="mt-2 text-sm text-danger" role="alert">
										Changing the Base URL requires replacing or removing the stored token.
									</p>
								) : null}
							</div>

							{requiresInsecureAck && !endpointUnchangedInsecure ? (
								<label className="flex items-start gap-2 text-sm text-ink">
									<input
										type="checkbox"
										className={`${checkboxClassName} mt-0.5`}
										checked={insecureHttpAcknowledged}
										onChange={(event) => {
											setInsecureHttpAcknowledged(event.currentTarget.checked);
											setSaveSuccess(false);
										}}
										disabled={savePending}
									/>
									<span>I understand this non-loopback HTTP endpoint is insecure and confirm using it anyway.</span>
								</label>
							) : null}
						</div>

						<div className="flex w-full shrink-0 flex-col justify-start gap-4 lg:w-48 lg:pt-6">
							<span
								className="inline-flex"
								title="Backend command not yet available"
								aria-describedby="test-connection-help"
							>
								<Button type="button" className={outlineButtonClassName} disabled focusableWhenDisabled>
									Test connection
								</Button>
							</span>
							<p id="test-connection-help" className="sr-only">
								Backend command not yet available
							</p>
							<div className="text-xs text-muted">
								<p className="font-medium text-ink">{credentialStatusText}</p>
								{credentialAction === "clear" ? <p className="mt-1">Token will be removed on save.</p> : null}
								{credentialAction === "replace" && token.trim() ? (
									<p className="mt-1">New token will replace the stored value on save.</p>
								) : null}
							</div>
							<label className="flex items-center gap-2 text-sm text-ink">
								<input
									type="checkbox"
									className={checkboxClassName}
									checked={enabled}
									onChange={(event) => {
										setEnabled(event.currentTarget.checked);
										setSaveSuccess(false);
									}}
									disabled={savePending}
								/>
								Channel enabled
							</label>
						</div>
					</div>
				</section>

				<section className="shadow-frame border border-line p-6">
					<div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
						<div>
							<h3 className="text-xl font-bold text-ink">Models</h3>
							<p className="text-sm text-muted">Models enabled for this channel.</p>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							<span className="inline-flex" title="Backend command not yet available" aria-describedby="get-model-help">
								<Button type="button" className={outlineButtonClassName} disabled focusableWhenDisabled>
									Get model
								</Button>
							</span>
							<p id="get-model-help" className="sr-only">
								Backend command not yet available
							</p>
							<Button
								type="button"
								className={outlineButtonClassName}
								onClick={() => {
									setAddModelOpen(true);
								}}
							>
								+ Add model
							</Button>
						</div>
					</div>

					{modelsLoading ? (
						<p className="text-sm text-muted" aria-live="polite">
							Loading models…
						</p>
					) : null}

					{modelsError ? (
						<div className="mb-4 flex flex-col gap-2" role="alert">
							<p className="text-sm text-danger">{modelsError}</p>
							<Button
								type="button"
								className={outlineButtonClassName}
								onClick={() => {
									void reloadModels(providerId);
								}}
							>
								Retry
							</Button>
						</div>
					) : null}

					{modelMutationError ? (
						<p className="mb-4 text-sm text-danger" role="alert">
							{modelMutationError}
						</p>
					) : null}

					{!modelsLoading && !modelsError ? (
						<ModelsTable
							models={models}
							pendingModelIds={pendingModelIds}
							onEnabledChange={(modelId, nextEnabled) => {
								void handleModelEnabledChange(modelId, nextEnabled);
							}}
						/>
					) : null}
				</section>
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-3 border-t border-line bg-surface px-8 py-4">
				{saveError ? (
					<p className="mr-auto text-sm text-danger" role="alert">
						{saveError}
					</p>
				) : null}
				{saveSuccess && !saveError ? (
					<p className="mr-auto text-sm text-muted" aria-live="polite">
						Saved.
					</p>
				) : null}
				<Button type="button" className={outlineButtonClassName} disabled={savePending} onClick={resetConnectionForm}>
					Cancel
				</Button>
				<Button
					type="button"
					className={primaryButtonClassName}
					disabled={savePending || !formValid}
					focusableWhenDisabled
					onClick={() => {
						void handleSave();
					}}
				>
					{savePending ? "Saving…" : "Save"}
				</Button>
			</footer>

			<AddManualModelDialog
				open={addModelOpen}
				providerId={providerId}
				onOpenChange={setAddModelOpen}
				onCreated={() => {
					void reloadModels(providerId);
				}}
			/>
		</div>
	);
}
