// ABOUTME: Selected provider editor for connection settings and model management.
// ABOUTME: Coordinates local form state with real provider and model storage IPC.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@base-ui/react/button";
import { Switch } from "@base-ui/react/switch";
import IconMaterialSymbolsLightEditSquareOutlineSharp from "~icons/material-symbols-light/edit-square-outline-sharp";
import IconMaterialSymbolsLightCheck from "~icons/material-symbols-light/check";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightDeleteOutlineSharp from "~icons/material-symbols-light/delete-outline-sharp";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/toast/useToast";
import {
	checkboxClassName,
	dangerButtonClassName,
	iconButtonClassName,
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	switchRootClassName,
	switchThumbClassName,
} from "../../components/ui";
import {
	deleteProviderInstance,
	deleteProviderModel,
	listProviderModels,
	saveManualModel,
	saveProviderInstance,
	setModelEnabled,
	syncProviderModels,
	testProviderConnection,
} from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type {
	ConnectionTestResult,
	CredentialUpdate,
	ProviderInstanceDto,
	ProviderModelDto,
} from "../../storage/types";
import { getAdapterLabel, getDefaultBaseUrl } from "./adapterOptions";
import { AddManualModelDialog } from "./AddManualModelDialog";
import { useModelsContext } from "./ModelsContext";
import { ModelsTable } from "./ModelsTable";

export type ProviderEditorProps = {
	providerId: string;
};

/** Danger-toned ghost icon button for destructive actions such as deleting the channel. */
const dangerIconButtonClassName =
	"inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-none border-0 bg-transparent text-danger hover:bg-surface-2 hover:text-danger active:bg-surface-3 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink data-disabled:text-disabled disabled:text-disabled";

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

function formatSyncTimestamp(iso: string | null): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	return date.toLocaleString();
}

function syncStatusLabel(provider: ProviderInstanceDto, syncPending: boolean): string {
	if (syncPending) {
		return "Syncing models…";
	}
	switch (provider.modelsSyncStatus) {
		case "never":
			return "Never synced";
		case "ok": {
			const at = formatSyncTimestamp(provider.modelsSyncedAt);
			return at ? `Last successful sync: ${at}` : "Last sync succeeded";
		}
		case "error": {
			const code = provider.modelsSyncErrorCode ? ` (${provider.modelsSyncErrorCode})` : "";
			const at = formatSyncTimestamp(provider.modelsSyncedAt);
			const lastOk = at ? ` Last successful sync: ${at}.` : "";
			return `Sync error${code}.${lastOk}`;
		}
		default:
			return "Sync status unknown";
	}
}

export function ProviderEditor({ providerId }: ProviderEditorProps) {
	const { providers, providersLoading, providersError, upsertProvider, removeProvider, refreshProviders } =
		useModelsContext();
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
	return (
		<ProviderEditorLoaded
			key={provider.id}
			provider={provider}
			upsertProvider={upsertProvider}
			removeProvider={removeProvider}
		/>
	);
}

type ProviderEditorLoadedProps = {
	provider: ProviderInstanceDto;
	upsertProvider: (provider: ProviderInstanceDto) => void;
	removeProvider: (id: string) => void;
};

function ProviderEditorLoaded({ provider, upsertProvider, removeProvider }: ProviderEditorLoadedProps) {
	const navigate = useNavigate();
	const toast = useToast();
	const [baseUrlOverride, setBaseUrlOverride] = useState(provider.baseUrlOverride ?? "");
	const [enabled, setEnabled] = useState(provider.enabled);
	const [token, setToken] = useState("");
	const [credentialAction, setCredentialAction] = useState<CredentialAction>("keep");
	const [insecureHttpAcknowledged, setInsecureHttpAcknowledged] = useState(false);

	const [savePending, setSavePending] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveSuccess, setSaveSuccess] = useState(false);

	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [renamePending, setRenamePending] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);

	const [models, setModels] = useState<ProviderModelDto[]>([]);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [pendingModelIds, setPendingModelIds] = useState<Set<string>>(() => new Set());
	const [modelMutationError, setModelMutationError] = useState<string | null>(null);
	const [addModelOpen, setAddModelOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [selectionMode, setSelectionMode] = useState(false);
	const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(() => new Set());
	const [deleteModelsOpen, setDeleteModelsOpen] = useState(false);
	const [deleteModelsPending, setDeleteModelsPending] = useState(false);

	const [connectionTestPending, setConnectionTestPending] = useState(false);
	const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(null);
	const [connectionTestIpcError, setConnectionTestIpcError] = useState<string | null>(null);
	/** Bumped on form edits / new tests so stale in-flight results are discarded. */
	const connectionTestGeneration = useRef(0);
	/** Latest provider.updatedAt for post-await version checks (avoid stale render closures). */
	const providerUpdatedAtRef = useRef(provider.updatedAt);

	useEffect(() => {
		providerUpdatedAtRef.current = provider.updatedAt;
	}, [provider.updatedAt]);

	// Focus and select the rename input when inline editing starts.
	useEffect(() => {
		if (!renaming) return;
		const node = renameInputRef.current;
		if (node) {
			node.focus();
			node.select();
		}
	}, [renaming]);

	const [syncPending, setSyncPending] = useState(false);

	const providerId = provider.id;

	const clearConnectionTestResult = useCallback(() => {
		connectionTestGeneration.current += 1;
		setConnectionTestResult(null);
		setConnectionTestIpcError(null);
	}, []);

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

	// Connection-relevant dirty state: unsaved Base URL or credential replace/clear.
	const connectionDirty =
		normalizedBaseUrl !== savedBaseUrl || credentialAction === "replace" || credentialAction === "clear";

	// Disable connection form + Save while test/sync is in flight so mid-flight
	// edits cannot race results (backend still re-checks connection identity on sync).
	const connectionFormDisabled = savePending || syncPending || connectionTestPending;

	const remoteActionsDisabled = connectionDirty || connectionTestPending || syncPending || savePending || modelsLoading;

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

	// Block rename while a connection save / sync / test is in flight to avoid
	// racing provider.updatedAt and stale-result discard logic.
	const renameDisabled = savePending || syncPending || connectionTestPending;

	function startRename() {
		setRenameValue(provider.displayName);
		setRenameError(null);
		setRenaming(true);
	}

	function cancelRename() {
		setRenaming(false);
		setRenameValue("");
		setRenameError(null);
	}

	async function commitRename() {
		const trimmed = renameValue.trim();
		if (!trimmed || renamePending) {
			return;
		}
		if (trimmed === provider.displayName) {
			cancelRename();
			return;
		}
		setRenamePending(true);
		setRenameError(null);
		try {
			const saved = await saveProviderInstance({
				id: provider.id,
				adapterId: provider.adapterId,
				displayName: trimmed,
				baseUrlOverride: provider.baseUrlOverride,
				credentialKind: provider.credentialKind,
				credential: { action: "keep" },
				enabled: provider.enabled,
				proxyMode: provider.proxyMode,
				insecureHttpConfirmedAt: provider.insecureHttpConfirmedAt,
			});
			upsertProvider(saved);
			setRenaming(false);
			setRenameValue("");
		} catch (error: unknown) {
			setRenameError(getIpcErrorMessage(error, "Failed to rename channel."));
		} finally {
			setRenamePending(false);
		}
	}

	async function handleSave() {
		if (!formValid || savePending || syncPending) {
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
			// Clear stale connection-test result after a successful save.
			clearConnectionTestResult();
			toast.success({ title: "Channel saved", description: "Connection settings were updated." });
		} catch (error: unknown) {
			const message = getIpcErrorMessage(error, "Failed to save channel.");
			setSaveError(message);
			toast.error({ title: "Save failed", description: message });
		} finally {
			setSavePending(false);
		}
	}

	async function handleTestConnection() {
		if (remoteActionsDisabled || connectionTestPending) {
			return;
		}
		const generation = connectionTestGeneration.current + 1;
		connectionTestGeneration.current = generation;
		const testedProviderId = provider.id;
		// Capture version at click time; backend also returns providerUpdatedAt for compare.
		const testedUpdatedAt = provider.updatedAt;
		setConnectionTestPending(true);
		setConnectionTestResult(null);
		setConnectionTestIpcError(null);
		try {
			const result = await testProviderConnection(testedProviderId);
			// Discard if a newer test started, form was edited, selection changed, or
			// the provider connection version no longer matches (save / remote refresh).
			const versionStillCurrent =
				result.providerUpdatedAt === testedUpdatedAt && providerUpdatedAtRef.current === testedUpdatedAt;
			if (connectionTestGeneration.current !== generation || testedProviderId !== providerId || !versionStillCurrent) {
				return;
			}
			setConnectionTestResult(result);
			if (result.ok) {
				toast.success({ title: "Connection OK", description: result.message });
			} else {
				toast.error({ title: "Connection failed", description: result.message });
			}
		} catch (error: unknown) {
			if (
				connectionTestGeneration.current !== generation ||
				testedProviderId !== providerId ||
				providerUpdatedAtRef.current !== testedUpdatedAt
			) {
				return;
			}
			const message = getIpcErrorMessage(error, "Failed to test connection.");
			setConnectionTestIpcError(message);
			toast.error({ title: "Connection test failed", description: message });
		} finally {
			if (connectionTestGeneration.current === generation) {
				setConnectionTestPending(false);
			}
		}
	}

	async function handleSyncModels() {
		if (remoteActionsDisabled || syncPending || modelsLoading) {
			return;
		}
		setSyncPending(true);
		try {
			const result = await syncProviderModels(provider.id);
			// Always apply returned snapshot on successful IPC, regardless of result.ok.
			setModels(result.models);
			upsertProvider(result.provider);
			// Clear a prior list-load error so the models table can reappear with the
			// sync snapshot (including empty lists after a successful remote fetch).
			setModelsError(null);
			setModelsLoading(false);
			if (result.ok) {
				toast.success({ title: "Synced models", description: result.message });
			} else {
				toast.error({
					title: "Sync failed",
					description: result.errorCode ? `${result.message} (${result.errorCode})` : result.message,
				});
			}
		} catch (error: unknown) {
			// Preserve displayed models only when IPC itself fails.
			const message = getIpcErrorMessage(error, "Failed to sync models.");
			toast.error({ title: "Sync failed", description: message });
		} finally {
			setSyncPending(false);
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
			const message = getIpcErrorMessage(error, "Failed to update model.");
			setModelMutationError(message);
			toast.error({ title: "Update failed", description: message });
		} finally {
			setPendingModelIds((current) => {
				const next = new Set(current);
				next.delete(modelId);
				return next;
			});
		}
	}

	async function handleRenameModel(model: ProviderModelDto, displayNameOverride: string | null): Promise<boolean> {
		if (pendingModelIds.has(model.id)) {
			return false;
		}

		const previous = models.find((m) => m.id === model.id);
		if (!previous) {
			return false;
		}

		setModelMutationError(null);
		setPendingModelIds((current) => new Set(current).add(model.id));
		setModels((current) => current.map((m) => (m.id === model.id ? { ...m, displayNameOverride } : m)));

		try {
			const updated = await saveManualModel({
				id: model.id,
				providerInstanceId: provider.id,
				modelKey: model.modelKey,
				displayNameOverride,
				enabled: model.enabled,
				capabilityOverridesJson: model.capabilityOverridesJson,
			});
			setModels((current) => current.map((m) => (m.id === model.id ? updated : m)));
			return true;
		} catch (error: unknown) {
			setModels((current) => current.map((m) => (m.id === model.id ? previous : m)));
			setModelMutationError(getIpcErrorMessage(error, "Failed to update model."));
			return false;
		} finally {
			setPendingModelIds((current) => {
				const next = new Set(current);
				next.delete(model.id);
				return next;
			});
		}
	}

	function enterSelectionMode() {
		setSelectedModelIds(new Set());
		setSelectionMode(true);
	}

	function exitSelectionMode() {
		setSelectedModelIds(new Set());
		setSelectionMode(false);
	}

	function handleToggleSelect(modelId: string) {
		setSelectedModelIds((current) => {
			const next = new Set(current);
			if (next.has(modelId)) {
				next.delete(modelId);
			} else {
				next.add(modelId);
			}
			return next;
		});
	}

	function handleToggleSelectAll(checked: boolean, visibleModelIds: readonly string[]) {
		if (checked) {
			setSelectedModelIds(new Set(visibleModelIds));
		} else {
			setSelectedModelIds(new Set());
		}
	}

	async function handleDeleteModels() {
		const ids = Array.from(selectedModelIds);
		if (ids.length === 0 || deleteModelsPending) {
			return;
		}

		const idSet = new Set(ids);
		setModelMutationError(null);
		setDeleteModelsPending(true);
		setPendingModelIds((current) => {
			const next = new Set(current);
			for (const id of ids) {
				next.add(id);
			}
			return next;
		});
		setModels((current) => current.filter((model) => !idSet.has(model.id)));

		try {
			const results = await Promise.allSettled(ids.map((id) => deleteProviderModel(id)));
			const anyFailed = results.some((result) => result.status === "rejected");
			if (anyFailed) {
				await reloadModels(providerId);
				const firstRejection = results.find((result) => result.status === "rejected");
				const reason = firstRejection && firstRejection.status === "rejected" ? firstRejection.reason : undefined;
				const message = getIpcErrorMessage(reason, "Failed to delete some models.");
				setModelMutationError(message);
				toast.error({ title: "Delete failed", description: message });
			} else {
				setSelectedModelIds(new Set());
				setSelectionMode(false);
				const count = ids.length;
				toast.success({
					title: count === 1 ? "Model deleted" : "Models deleted",
					description: count === 1 ? "Removed 1 model." : `Removed ${count} models.`,
				});
			}
		} finally {
			setPendingModelIds((current) => {
				const next = new Set(current);
				for (const id of ids) {
					next.delete(id);
				}
				return next;
			});
			setDeleteModelsPending(false);
		}
	}

	async function handleDelete() {
		try {
			await deleteProviderInstance(provider.id);
		} catch (err: unknown) {
			const error = new Error(getIpcErrorMessage(err, "Failed to delete channel."));
			throw Object.assign(error, { cause: err });
		}
		removeProvider(provider.id);
		void navigate({ to: "/models" });
	}

	const defaultBaseUrl = getDefaultBaseUrl(provider.adapterId);
	const tokenDisabled = provider.credentialKind === "none" || credentialAction === "clear";
	const tokenPlaceholder =
		credentialAction === "clear"
			? "Token will be removed on save"
			: provider.hasCredential
				? "•••••••••••• (stored)"
				: "Enter API token";

	// Only show results that still match the current provider connection version.
	const visibleConnectionTestResult =
		connectionTestResult && connectionTestResult.providerUpdatedAt === provider.updatedAt ? connectionTestResult : null;

	const connectionResultClass = visibleConnectionTestResult?.ok
		? "text-sm text-accent"
		: visibleConnectionTestResult
			? "text-sm text-danger"
			: "text-sm text-muted";

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto p-8">
				<header className="mb-8">
					<div className="mb-2 flex items-center justify-between gap-4">
						{renaming ? (
							<form
								className="flex min-w-0 flex-1 items-center gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									void commitRename();
								}}
							>
								<input
									ref={renameInputRef}
									className="h-10 w-full max-w-md rounded-none border border-line bg-surface px-2 text-3xl font-bold text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-ink disabled:border-disabled disabled:text-disabled"
									value={renameValue}
									onChange={(event) => {
										setRenameValue(event.currentTarget.value);
										setRenameError(null);
									}}
									onKeyDown={(event) => {
										if (event.key === "Escape" && !renamePending) {
											event.preventDefault();
											cancelRename();
										}
									}}
									maxLength={200}
									spellCheck={false}
									autoComplete="off"
									disabled={renamePending}
								/>
								<Button
									type="submit"
									className={iconButtonClassName}
									aria-label="Save channel name"
									disabled={renamePending || !renameValue.trim()}
								>
									<IconMaterialSymbolsLightCheck className="pointer-events-none size-5 shrink-0" />
								</Button>
								<Button
									type="button"
									className={iconButtonClassName}
									aria-label="Cancel rename"
									disabled={renamePending}
									onClick={cancelRename}
								>
									<IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
								</Button>
							</form>
						) : (
							<div className="flex items-center gap-1">
								<h1 className="text-3xl font-bold text-ink">{provider.displayName}</h1>
								<Button
									type="button"
									className={iconButtonClassName}
									aria-label="Rename channel"
									title="Rename channel"
									disabled={renameDisabled}
									onClick={startRename}
								>
									<IconMaterialSymbolsLightEditSquareOutlineSharp className="pointer-events-none size-5 shrink-0" />
								</Button>
							</div>
						)}
						<label className="flex shrink-0 items-center gap-2 text-sm text-ink">
							<Switch.Root
								checked={enabled}
								onCheckedChange={(checked) => {
									setEnabled(checked);
									setSaveSuccess(false);
									clearConnectionTestResult();
								}}
								disabled={connectionFormDisabled}
								className={switchRootClassName}
							>
								<Switch.Thumb className={switchThumbClassName} />
							</Switch.Root>
						</label>
					</div>
					{renameError ? (
						<p className="mb-2 text-sm text-danger" role="alert">
							{renameError}
						</p>
					) : null}
					<hr className="mb-4 border-line" />
					<p className="text-sm text-muted">
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
										clearConnectionTestResult();
									}}
									placeholder={defaultBaseUrl ?? "https://…"}
									spellCheck={false}
									disabled={connectionFormDisabled}
								/>
								{defaultBaseUrl ? <p className="mt-1 text-xs text-muted">Default: {defaultBaseUrl}</p> : null}
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
										clearConnectionTestResult();
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
									disabled={connectionFormDisabled || tokenDisabled}
								/>
								{provider.credentialKind !== "none" && provider.hasCredential ? (
									<div className="mt-2 flex flex-wrap gap-2">
										{credentialAction !== "clear" ? (
											<Button
												type="button"
												className={outlineButtonClassName}
												disabled={connectionFormDisabled}
												onClick={() => {
													setCredentialAction("clear");
													setToken("");
													setSaveSuccess(false);
													clearConnectionTestResult();
												}}
											>
												Remove stored token
											</Button>
										) : (
											<Button
												type="button"
												className={outlineButtonClassName}
												disabled={connectionFormDisabled}
												onClick={() => {
													setCredentialAction("keep");
													setToken("");
													setSaveSuccess(false);
													clearConnectionTestResult();
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
										disabled={connectionFormDisabled}
									/>
									<span>I understand this non-loopback HTTP endpoint is insecure and confirm using it anyway.</span>
								</label>
							) : null}
						</div>

						<div className="flex w-full shrink-0 flex-col justify-start gap-4 lg:w-48 lg:pt-6">
							<span
								className="inline-flex"
								title={
									connectionDirty
										? "Save connection changes before testing or syncing models."
										: connectionTestPending
											? "Testing connection…"
											: "Test the saved connection"
								}
							>
								<Button
									type="button"
									className={outlineButtonClassName}
									disabled={remoteActionsDisabled}
									focusableWhenDisabled
									onClick={() => {
										void handleTestConnection();
									}}
								>
									{connectionTestPending ? "Testing…" : "Test connection"}
								</Button>
							</span>
							{connectionDirty ? (
								<p className="text-xs text-muted" id="connection-dirty-help">
									Save connection changes before testing or syncing models.
								</p>
							) : null}
							<div aria-live="polite" className="min-h-5">
								{connectionTestIpcError ? (
									<p className="text-sm text-danger" role="alert">
										{connectionTestIpcError}
									</p>
								) : null}
								{visibleConnectionTestResult && !connectionTestIpcError ? (
									<p className={connectionResultClass}>
										{visibleConnectionTestResult.message}
										{!visibleConnectionTestResult.ok && visibleConnectionTestResult.errorCode
											? ` [${visibleConnectionTestResult.errorCode}]`
											: null}
									</p>
								) : null}
							</div>
							<div className="text-xs text-muted">
								{credentialAction === "clear" ? <p className="mt-1">Token will be removed on save.</p> : null}
								{credentialAction === "replace" && token.trim() ? (
									<p className="mt-1">New token will replace the stored value on save.</p>
								) : null}
							</div>
						</div>
					</div>
				</section>

				<section className="shadow-frame border border-line p-6">
					<div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
						<div>
							<h3 className="text-xl font-bold text-ink">Models</h3>
							<p className="mt-1 text-xs text-muted" aria-live="polite">
								{syncStatusLabel(provider, syncPending)}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							{selectionMode ? (
								<>
									<Button
										type="button"
										className={dangerButtonClassName}
										disabled={selectedModelIds.size === 0 || syncPending || deleteModelsPending}
										onClick={() => {
											setDeleteModelsOpen(true);
										}}
									>
										Delete ({selectedModelIds.size})
									</Button>
									<Button
										type="button"
										className={outlineButtonClassName}
										disabled={deleteModelsPending}
										onClick={exitSelectionMode}
									>
										Done
									</Button>
								</>
							) : (
								<>
									<span
										className="inline-flex"
										title={
											connectionDirty
												? "Save connection changes before testing or syncing models."
												: syncPending
													? "Syncing models…"
													: "Fetch remote models using the saved connection"
										}
									>
										<Button
											type="button"
											className={outlineButtonClassName}
											disabled={remoteActionsDisabled}
											focusableWhenDisabled
											onClick={() => {
												void handleSyncModels();
											}}
										>
											{syncPending ? "Syncing…" : "Get models"}
										</Button>
									</span>
									<Button
										type="button"
										className={outlineButtonClassName}
										onClick={() => {
											setAddModelOpen(true);
										}}
									>
										+ Add model
									</Button>
									<Button
										type="button"
										className={outlineButtonClassName}
										disabled={models.length === 0 || modelsLoading || Boolean(modelsError) || syncPending}
										onClick={enterSelectionMode}
									>
										Select
									</Button>
								</>
							)}
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
							onRenameModel={handleRenameModel}
							selectionMode={selectionMode}
							selectedModelIds={selectedModelIds}
							onToggleSelect={handleToggleSelect}
							onToggleSelectAll={handleToggleSelectAll}
						/>
					) : null}
				</section>
			</div>

			<footer className="flex shrink-0 items-center justify-end gap-3 border-t border-line bg-surface px-8 py-4">
				<Button
					type="button"
					className={`${dangerIconButtonClassName} mr-auto`}
					aria-label="Delete channel"
					title="Delete channel"
					disabled={connectionFormDisabled}
					onClick={() => {
						setDeleteOpen(true);
					}}
				>
					<IconMaterialSymbolsLightDeleteOutlineSharp className="pointer-events-none size-5 shrink-0" />
				</Button>

				<Button
					type="button"
					className={outlineButtonClassName}
					disabled={connectionFormDisabled}
					onClick={resetConnectionForm}
				>
					Cancel
				</Button>
				<Button
					type="button"
					className={primaryButtonClassName}
					disabled={connectionFormDisabled || !formValid}
					focusableWhenDisabled
					onClick={() => {
						void handleSave();
					}}
				>
					{savePending ? "Saving…" : syncPending ? "Syncing…" : connectionTestPending ? "Testing…" : "Save"}
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

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title="Delete channel"
				description={
					<>
						Delete <span className="font-bold text-ink">{provider.displayName}</span> and all its models? This cannot be
						undone.
					</>
				}
				confirmText="Delete"
				pendingText="Deleting…"
				danger
				onConfirm={handleDelete}
			/>

			<ConfirmDialog
				open={deleteModelsOpen}
				onOpenChange={setDeleteModelsOpen}
				title="Delete models"
				description={
					<>
						Delete <span className="font-bold text-ink">{selectedModelIds.size}</span> selected model
						{selectedModelIds.size === 1 ? "" : "s"}? This cannot be undone.
					</>
				}
				confirmText="Delete"
				pendingText="Deleting…"
				danger
				onConfirm={handleDeleteModels}
			/>
		</div>
	);
}
