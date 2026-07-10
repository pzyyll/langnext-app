// ABOUTME: Dialog for creating a real provider instance through Tauri IPC.
// ABOUTME: Collects adapter, endpoint, credential policy, and initial enabled state.
import { useState } from "react";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import {
	checkboxClassName,
	dialogBackdropClassName,
	dialogPopupClassName,
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	selectClassName,
} from "../../components/ui";
import { saveProviderInstance } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { CredentialKind, CredentialUpdate, ProviderInstanceDto } from "../../storage/types";
import { ADAPTER_OPTIONS, getDefaultBaseUrl } from "./adapterOptions";

export type AddProviderDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (provider: ProviderInstanceDto) => void;
};

export function AddProviderDialog({ open, onOpenChange, onCreated }: AddProviderDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={dialogBackdropClassName} />
				<Dialog.Popup className={`${dialogPopupClassName} max-h-[min(90dvh,40rem)] w-md overflow-y-auto`}>
					<div className="flex flex-col gap-1">
						<Dialog.Title className="text-base leading-6 font-bold text-ink">Add channel</Dialog.Title>
						<Dialog.Description className="text-sm leading-5 text-muted">
							Create a provider instance. Credentials are stored only in the secure vault.
						</Dialog.Description>
					</div>
					{open ? (
						<AddProviderForm
							onCreated={(provider) => {
								onCreated(provider);
								onOpenChange(false);
							}}
						/>
					) : null}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

type AddProviderFormProps = {
	onCreated: (provider: ProviderInstanceDto) => void;
};

function AddProviderForm({ onCreated }: AddProviderFormProps) {
	const [displayName, setDisplayName] = useState("");
	const [adapterId, setAdapterId] = useState(ADAPTER_OPTIONS[0]?.id ?? "openai-compatible");
	const [baseUrlOverride, setBaseUrlOverride] = useState("");
	const [credentialKind, setCredentialKind] = useState<CredentialKind>("api_key");
	const [token, setToken] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const defaultBaseUrl = getDefaultBaseUrl(adapterId);
	const canSubmit = displayName.trim().length > 0 && !pending;

	async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canSubmit) {
			return;
		}

		const normalizedBaseUrl = baseUrlOverride.trim() ? baseUrlOverride.trim() : null;
		const kind = credentialKind;
		let credential: CredentialUpdate;
		if (kind === "none") {
			credential = { action: "clear" };
		} else if (token.trim()) {
			credential = { action: "replace", value: token.trim() };
		} else {
			credential = { action: "keep" };
		}

		setPending(true);
		setError(null);
		try {
			const created = await saveProviderInstance({
				id: null,
				adapterId,
				displayName: displayName.trim(),
				baseUrlOverride: normalizedBaseUrl,
				credentialKind: kind,
				credential,
				enabled,
				proxyMode: "inherit",
				insecureHttpConfirmedAt: null,
			});
			onCreated(created);
		} catch (err: unknown) {
			setError(getIpcErrorMessage(err, "Failed to create channel."));
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-provider-name">
					Display name
				</label>
				<input
					id="add-provider-name"
					className={inputClassName}
					value={displayName}
					onChange={(event) => {
						setDisplayName(event.currentTarget.value);
					}}
					maxLength={200}
					required
					autoFocus
					disabled={pending}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-provider-adapter">
					API Type
				</label>
				<select
					id="add-provider-adapter"
					className={selectClassName}
					value={adapterId}
					onChange={(event) => {
						setAdapterId(event.currentTarget.value);
					}}
					disabled={pending}
				>
					{ADAPTER_OPTIONS.map((option) => (
						<option key={option.id} value={option.id}>
							{option.label}
						</option>
					))}
				</select>
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-provider-base-url">
					Base URL override
				</label>
				<input
					id="add-provider-base-url"
					className={inputClassName}
					value={baseUrlOverride}
					onChange={(event) => {
						setBaseUrlOverride(event.currentTarget.value);
					}}
					placeholder={defaultBaseUrl ?? "Optional"}
					spellCheck={false}
					disabled={pending}
				/>
				{defaultBaseUrl ? <p className="text-xs text-muted">Default: {defaultBaseUrl}</p> : null}
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-provider-credential-kind">
					Credential kind
				</label>
				<select
					id="add-provider-credential-kind"
					className={selectClassName}
					value={credentialKind}
					onChange={(event) => {
						setCredentialKind(event.currentTarget.value as CredentialKind);
					}}
					disabled={pending}
				>
					<option value="api_key">API key</option>
					<option value="bearer">Bearer</option>
					<option value="none">None</option>
				</select>
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-provider-token">
					API token
				</label>
				<input
					id="add-provider-token"
					className={inputClassName}
					type="password"
					value={token}
					onChange={(event) => {
						setToken(event.currentTarget.value);
					}}
					placeholder={credentialKind === "none" ? "Not used" : "Optional"}
					spellCheck={false}
					autoComplete="off"
					disabled={pending || credentialKind === "none"}
				/>
			</div>

			<label className="flex items-center gap-2 text-sm text-ink">
				<input
					type="checkbox"
					className={checkboxClassName}
					checked={enabled}
					onChange={(event) => {
						setEnabled(event.currentTarget.checked);
					}}
					disabled={pending}
				/>
				Channel enabled
			</label>

			{error ? (
				<p className="text-sm text-danger" role="alert">
					{error}
				</p>
			) : null}

			<div className="flex justify-end gap-3 pt-1">
				<Dialog.Close className={outlineButtonClassName} disabled={pending}>
					Cancel
				</Dialog.Close>
				<Button type="submit" className={primaryButtonClassName} disabled={!canSubmit} focusableWhenDisabled>
					{pending ? "Creating…" : "Create"}
				</Button>
			</div>
		</form>
	);
}
