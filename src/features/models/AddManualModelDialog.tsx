// ABOUTME: Dialog for adding a manual model to the selected provider.
// ABOUTME: Persists model identity, display override, and enabled state through IPC.
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
} from "../../components/ui";
import { saveManualModel } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { ProviderModelDto } from "../../storage/types";

export type AddManualModelDialogProps = {
	open: boolean;
	providerId: string;
	onOpenChange: (open: boolean) => void;
	onCreated: (model: ProviderModelDto) => void;
};

export function AddManualModelDialog({ open, providerId, onOpenChange, onCreated }: AddManualModelDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={dialogBackdropClassName} />
				<Dialog.Popup className={dialogPopupClassName}>
					<div className="flex flex-col gap-1">
						<Dialog.Title className="text-base leading-6 font-bold text-ink">Add model</Dialog.Title>
						<Dialog.Description className="text-sm leading-5 text-muted">
							Register a manual model key for this channel.
						</Dialog.Description>
					</div>
					{open ? (
						<AddManualModelForm
							providerId={providerId}
							onCreated={(model) => {
								onCreated(model);
								onOpenChange(false);
							}}
						/>
					) : null}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

type AddManualModelFormProps = {
	providerId: string;
	onCreated: (model: ProviderModelDto) => void;
};

function AddManualModelForm({ providerId, onCreated }: AddManualModelFormProps) {
	const [modelKey, setModelKey] = useState("");
	const [displayNameOverride, setDisplayNameOverride] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canSubmit = modelKey.trim().length > 0 && !pending;

	async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canSubmit) {
			return;
		}

		setPending(true);
		setError(null);
		try {
			const created = await saveManualModel({
				id: null,
				providerInstanceId: providerId,
				modelKey: modelKey.trim(),
				displayNameOverride: displayNameOverride.trim() ? displayNameOverride.trim() : null,
				enabled,
				capabilityOverridesJson: null,
			});
			onCreated(created);
		} catch (err: unknown) {
			setError(getIpcErrorMessage(err, "Failed to add model."));
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-model-key">
					Model ID
				</label>
				<input
					id="add-model-key"
					className={`${inputClassName} font-mono`}
					value={modelKey}
					onChange={(event) => {
						setModelKey(event.currentTarget.value);
					}}
					maxLength={256}
					required
					autoFocus
					spellCheck={false}
					disabled={pending}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<label className="text-sm font-medium text-ink" htmlFor="add-model-display-name">
					Display name override
				</label>
				<input
					id="add-model-display-name"
					className={inputClassName}
					value={displayNameOverride}
					onChange={(event) => {
						setDisplayNameOverride(event.currentTarget.value);
					}}
					placeholder="Optional"
					disabled={pending}
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
				Enabled
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
					{pending ? "Adding…" : "Add model"}
				</Button>
			</div>
		</form>
	);
}
