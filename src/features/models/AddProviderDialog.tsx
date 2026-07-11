// ABOUTME: Dialog for creating a real provider instance through Tauri IPC.
// ABOUTME: Collects adapter, endpoint, credential policy, and initial enabled state.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import {
	checkboxClassName,
	dialogBackdropClassName,
	dialogPopupClassName,
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	selectClassName,
} from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
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
	const { t } = useTranslation();

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={dialogBackdropClassName} />
				<Dialog.Popup className={`${dialogPopupClassName} max-h-[min(90dvh,40rem)] w-md overflow-y-auto`}>
					<div className="flex flex-col gap-1">
						<Dialog.Title className="text-title-dialog font-bold text-on-surface">
							{t("models.addChannel.title")}
						</Dialog.Title>
						<Dialog.Description className="text-body-tight text-neutral">
							{t("models.addChannel.description")}
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
	const { t } = useTranslation();
	const toast = useToast();
	const [displayName, setDisplayName] = useState("");
	const [adapterId, setAdapterId] = useState(ADAPTER_OPTIONS[0]?.id ?? "openai-compatible");
	const [baseUrlOverride, setBaseUrlOverride] = useState("");
	const [credentialKind, setCredentialKind] = useState<CredentialKind>("api_key");
	const [token, setToken] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const createMutation = useMutation({
		mutationFn: saveProviderInstance,
		onSuccess: (created) => {
			toast.success({ title: t("models.toast.channelCreated"), description: created.displayName });
			onCreated(created);
		},
		onError: (err: unknown) => {
			const message = getIpcErrorMessage(err, t("models.toast.createChannelFailed"));
			setError(message);
			toast.error({ title: t("models.toast.createFailed"), description: message });
		},
	});

	const pending = createMutation.isPending;
	const defaultBaseUrl = getDefaultBaseUrl(adapterId);
	const canSubmit = displayName.trim().length > 0 && !pending;

	function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
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

		setError(null);
		createMutation.mutate({
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
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
			<div className="flex flex-col gap-1">
				<label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-name">
					{t("models.displayName")}
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
				<label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-adapter">
					{t("models.apiTypeLabel")}
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
				<label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-base-url">
					{t("models.baseUrlOverride")}
				</label>
				<input
					id="add-provider-base-url"
					className={inputClassName}
					value={baseUrlOverride}
					onChange={(event) => {
						setBaseUrlOverride(event.currentTarget.value);
					}}
					placeholder={defaultBaseUrl ?? t("common.optional")}
					spellCheck={false}
					disabled={pending}
				/>
				{defaultBaseUrl ? (
					<p className="text-xs text-neutral">{t("common.default", { value: defaultBaseUrl })}</p>
				) : null}
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-credential-kind">
					{t("models.credentialKind")}
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
					<option value="api_key">{t("models.credentialApiKey")}</option>
					<option value="bearer">{t("models.credentialBearer")}</option>
					<option value="none">{t("models.credentialNone")}</option>
				</select>
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-body-tight font-medium text-on-surface" htmlFor="add-provider-token">
					{t("models.apiToken")}
				</label>
				<input
					id="add-provider-token"
					className={inputClassName}
					type="password"
					value={token}
					onChange={(event) => {
						setToken(event.currentTarget.value);
					}}
					placeholder={credentialKind === "none" ? t("models.addChannel.tokenNotUsed") : t("common.optional")}
					spellCheck={false}
					autoComplete="off"
					disabled={pending || credentialKind === "none"}
				/>
			</div>

			<label className="flex items-center gap-2 text-body-tight text-on-surface">
				<input
					type="checkbox"
					className={checkboxClassName}
					checked={enabled}
					onChange={(event) => {
						setEnabled(event.currentTarget.checked);
					}}
					disabled={pending}
				/>
				{t("models.channelEnabled")}
			</label>

			{error ? (
				<p className="text-body-tight text-error" role="alert">
					{error}
				</p>
			) : null}

			<div className="flex justify-end gap-3 pt-1">
				<Dialog.Close className={outlineButtonClassName} disabled={pending}>
					{t("common.cancel")}
				</Dialog.Close>
				<Button type="submit" className={primaryButtonClassName} disabled={!canSubmit} focusableWhenDisabled>
					{pending ? t("common.creating") : t("models.addChannel.create")}
				</Button>
			</div>
		</form>
	);
}
