// ABOUTME: Modal dialog for editing model API type, capability limits, and request defaults.
// ABOUTME: Separates model limits from profile-overridable runtime values and persists them through IPC.
import { useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import {
	checkboxClassName,
	dialogBackdropClassName,
	dialogPopupClassName,
	iconButtonClassName,
	inputClassName,
	outlineButtonClassName,
	primaryButtonClassName,
	selectClassName,
} from "../../components/ui";
import { useToast } from "../../components/toast/useToast";
import { updateModelConfig } from "../../storage/client";
import { getIpcErrorMessage } from "../../storage/errors";
import type { CapabilityOverridesV1, ProviderModelDto } from "../../storage/types";
import { ADAPTER_OPTIONS, getAdapterLabel } from "./adapterOptions";

const TOKEN_MIN = 1;
const TOKEN_MAX = 0xffff_ffff;
const DEFAULT_CONTEXT_LIMIT = 128 * 1024;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024;
const DEFAULT_REQUEST_TOKENS = 4096;

export type EditModelConfigDialogProps = {
	open: boolean;
	model: ProviderModelDto | null;
	onOpenChange: (open: boolean) => void;
	onSaved: (model: ProviderModelDto) => void;
};

export function EditModelConfigDialog({ open, model, onOpenChange, onSaved }: EditModelConfigDialogProps) {
	const { t } = useTranslation();

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={dialogBackdropClassName} />
				<Dialog.Popup className={`${dialogPopupClassName} w-md max-h-[min(90dvh,40rem)] gap-0 overflow-y-auto p-0`}>
					<div className="flex items-center justify-between border-b border-line px-4 py-4">
						<div className="flex min-w-0 flex-col gap-0.5">
							<Dialog.Title className="text-headline-sm font-bold tracking-tight text-on-surface uppercase italic">
								{t("models.editModelConfig.title")}
							</Dialog.Title>
							<Dialog.Description className="truncate font-mono text-xs text-neutral">
								{model?.modelKey ?? t("models.editModelConfig.title")}
							</Dialog.Description>
						</div>
						<Dialog.Close className={iconButtonClassName} aria-label={t("common.close")}>
							<IconMaterialSymbolsLightClose className="pointer-events-none size-5 shrink-0" />
						</Dialog.Close>
					</div>
					{open && model ? (
						<EditModelConfigForm
							key={model.id}
							model={model}
							onSaved={(updated) => {
								onSaved(updated);
								onOpenChange(false);
							}}
						/>
					) : null}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

type EditModelConfigFormProps = {
	model: ProviderModelDto;
	onSaved: (model: ProviderModelDto) => void;
};

function EditModelConfigForm({ model, onSaved }: EditModelConfigFormProps) {
	const { t } = useTranslation();
	const toast = useToast();
	const initial = useMemo(() => formStateFromModel(model), [model]);

	const [adapterId, setAdapterId] = useState(initial.adapterId);
	const [textGeneration, setTextGeneration] = useState(initial.textGeneration);
	const [imageAnalysis, setImageAnalysis] = useState(initial.imageAnalysis);
	const [videoProcessing, setVideoProcessing] = useState(initial.videoProcessing);
	const [contextLimit, setContextLimit] = useState(initial.contextLimit);
	const [outputLimit, setOutputLimit] = useState(initial.outputLimit);
	const [requestMaxTokens, setRequestMaxTokens] = useState(initial.requestMaxTokens);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const adapterOptions = useMemo(() => {
		if (adapterId && !ADAPTER_OPTIONS.some((option) => option.id === adapterId)) {
			return [...ADAPTER_OPTIONS, { id: adapterId, label: getAdapterLabel(adapterId) }];
		}
		return ADAPTER_OPTIONS;
	}, [adapterId]);

	async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) {
			return;
		}

		setPending(true);
		setError(null);
		try {
			const nextAdapterId = adapterId.trim() ? adapterId.trim() : null;
			const capabilityOverridesJson = buildCapabilityOverrides({
				previous: model.capabilityOverridesJson,
				textGeneration,
				imageAnalysis,
				videoProcessing,
				contextLimit,
				outputLimit,
				requestMaxTokens,
			});
			const updated = await updateModelConfig({
				id: model.id,
				adapterId: nextAdapterId,
				capabilityOverridesJson,
			});
			toast.success({
				title: t("models.toast.modelConfigSaved"),
				description: updated.displayNameOverride ?? updated.remoteDisplayName ?? updated.modelKey,
			});
			onSaved(updated);
		} catch (err: unknown) {
			const message = getIpcErrorMessage(err, t("models.toast.updateModelFailed"));
			setError(message);
			toast.error({ title: t("models.toast.updateFailed"), description: message });
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="flex flex-col" onSubmit={(event) => void handleSubmit(event)}>
			<div className="space-y-6 p-6">
				<div className="space-y-2">
					<label
						className="block text-label-sm font-bold uppercase tracking-widest text-neutral"
						htmlFor="edit-model-api-type"
					>
						{t("models.apiTypeLabel")}
					</label>
					<select
						id="edit-model-api-type"
						className={selectClassName}
						value={adapterId}
						onChange={(event) => {
							setAdapterId(event.currentTarget.value);
						}}
						disabled={pending}
					>
						<option value="">{t("models.apiTypeInherit")}</option>
						{adapterOptions.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
					<p className="text-xs text-neutral">{t("models.apiTypeModelHint")}</p>
				</div>

				<div className="space-y-2">
					<span className="block text-label-sm font-bold uppercase tracking-widest text-neutral">
						{t("models.editModelConfig.capabilities")}
					</span>
					<div className="flex flex-wrap gap-4 pt-1">
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								className={checkboxClassName}
								checked={textGeneration}
								onChange={(event) => {
									setTextGeneration(event.currentTarget.checked);
								}}
								disabled={pending}
							/>
							<span className="text-body-tight font-medium text-on-surface">
								{t("models.editModelConfig.textGeneration")}
							</span>
						</label>
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								className={checkboxClassName}
								checked={imageAnalysis}
								onChange={(event) => {
									setImageAnalysis(event.currentTarget.checked);
								}}
								disabled={pending}
							/>
							<span className="text-body-tight font-medium text-on-surface">
								{t("models.editModelConfig.imageAnalysis")}
							</span>
						</label>
						<label className="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								className={checkboxClassName}
								checked={videoProcessing}
								onChange={(event) => {
									setVideoProcessing(event.currentTarget.checked);
								}}
								disabled={pending}
							/>
							<span className="text-body-tight font-medium text-on-surface">
								{t("models.editModelConfig.videoProcessing")}
							</span>
						</label>
					</div>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<label
							className="block text-label-sm font-bold uppercase tracking-widest text-neutral"
							htmlFor="edit-model-context-limit"
						>
							{t("models.editModelConfig.contextLimit")}
						</label>
						<input
							id="edit-model-context-limit"
							type="number"
							className={`${inputClassName} font-mono`}
							min={TOKEN_MIN}
							max={TOKEN_MAX}
							step={1}
							value={contextLimit}
							onChange={(event) => {
								setContextLimit(toPositiveInteger(event.currentTarget.value, DEFAULT_CONTEXT_LIMIT));
							}}
							disabled={pending}
							required
						/>
						<p className="text-xs text-neutral">{t("models.editModelConfig.contextLimitHint")}</p>
					</div>

					<div className="space-y-2">
						<label
							className="block text-label-sm font-bold uppercase tracking-widest text-neutral"
							htmlFor="edit-model-output-limit"
						>
							{t("models.editModelConfig.outputLimit")}
						</label>
						<input
							id="edit-model-output-limit"
							type="number"
							className={`${inputClassName} font-mono`}
							min={TOKEN_MIN}
							max={TOKEN_MAX}
							step={1}
							value={outputLimit}
							onChange={(event) => {
								const nextLimit = toPositiveInteger(event.currentTarget.value, DEFAULT_OUTPUT_LIMIT);
								setOutputLimit(nextLimit);
								setRequestMaxTokens((current) => Math.min(current, nextLimit));
							}}
							disabled={pending}
							required
						/>
						<p className="text-xs text-neutral">{t("models.editModelConfig.outputLimitHint")}</p>
					</div>
				</div>

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<label
							className="block text-label-sm font-bold uppercase tracking-widest text-neutral"
							htmlFor="edit-model-request-max-tokens"
						>
							{t("models.editModelConfig.requestMaxTokens")}
						</label>
						<span className="bg-on-surface px-1 font-mono text-body-tight font-bold text-surface">
							{requestMaxTokens}
						</span>
					</div>
					<input
						id="edit-model-request-max-tokens"
						type="range"
						className="h-2 w-full cursor-pointer accent-on-surface disabled:opacity-50"
						min={TOKEN_MIN}
						max={outputLimit}
						step={1}
						value={requestMaxTokens}
						aria-valuetext={t("models.editModelConfig.tokens", { count: requestMaxTokens })}
						onChange={(event) => {
							setRequestMaxTokens(Number(event.currentTarget.value));
						}}
						disabled={pending}
					/>
					<div className="mt-1 flex justify-between font-mono text-[10px] text-neutral">
						{tokenRangeMarks(outputLimit).map((mark) => (
							<span key={mark}>{mark}</span>
						))}
					</div>
					<p className="text-xs text-neutral">{t("models.editModelConfig.requestMaxTokensHint")}</p>
				</div>

				<div className="border-t border-dashed border-line pt-2" />

				{error ? (
					<p className="text-body-tight text-error" role="alert">
						{error}
					</p>
				) : null}
			</div>

			<div className="flex justify-end gap-3 border-t border-line bg-surface-2 p-4">
				<Dialog.Close className={outlineButtonClassName} disabled={pending}>
					{t("common.cancel")}
				</Dialog.Close>
				<Button type="submit" className={primaryButtonClassName} disabled={pending} focusableWhenDisabled>
					{pending ? t("common.saving") : t("models.editModelConfig.save")}
				</Button>
			</div>
		</form>
	);
}

type FormState = {
	adapterId: string;
	textGeneration: boolean;
	imageAnalysis: boolean;
	videoProcessing: boolean;
	contextLimit: number;
	outputLimit: number;
	requestMaxTokens: number;
};

function formStateFromModel(model: ProviderModelDto): FormState {
	const caps = model.capabilityOverridesJson;
	return {
		adapterId: model.adapterId ?? "",
		textGeneration: caps?.textGeneration ?? true,
		imageAnalysis: caps?.imageAnalysis ?? false,
		videoProcessing: caps?.videoProcessing ?? false,
		contextLimit: positiveIntegerOr(caps?.maxContextTokens, DEFAULT_CONTEXT_LIMIT),
		outputLimit: positiveIntegerOr(caps?.maxOutputTokens, DEFAULT_OUTPUT_LIMIT),
		requestMaxTokens: resolveInitialRequestTokens(caps),
	};
}

function positiveIntegerOr(value: number | null | undefined, fallback: number): number {
	if (value == null || !Number.isFinite(value) || value < TOKEN_MIN) {
		return fallback;
	}
	return Math.min(TOKEN_MAX, Math.round(value));
}

function toPositiveInteger(raw: string, fallback: number): number {
	return positiveIntegerOr(Number(raw), fallback);
}

function resolveInitialRequestTokens(caps: CapabilityOverridesV1 | null): number {
	const outputLimit = positiveIntegerOr(caps?.maxOutputTokens, DEFAULT_OUTPUT_LIMIT);
	return Math.min(positiveIntegerOr(caps?.defaultOutputTokens, DEFAULT_REQUEST_TOKENS), outputLimit);
}

function tokenRangeMarks(limit: number): number[] {
	return Array.from(
		new Set([TOKEN_MIN, 0.25, 0.5, 0.75, 1].map((ratio) => Math.max(TOKEN_MIN, Math.round(limit * ratio)))),
	);
}

function buildCapabilityOverrides(input: {
	previous: CapabilityOverridesV1 | null;
	textGeneration: boolean;
	imageAnalysis: boolean;
	videoProcessing: boolean;
	contextLimit: number;
	outputLimit: number;
	requestMaxTokens: number;
}): CapabilityOverridesV1 {
	const overrides: CapabilityOverridesV1 = {
		schemaVersion: 1,
		textGeneration: input.textGeneration,
		imageAnalysis: input.imageAnalysis,
		videoProcessing: input.videoProcessing,
		maxContextTokens: input.contextLimit,
		maxOutputTokens: input.outputLimit,
		defaultOutputTokens: input.requestMaxTokens,
	};
	// Preserve streaming when present so unrelated sparse fields are not dropped.
	if (input.previous?.streaming != null) {
		overrides.streaming = input.previous.streaming;
	}
	return overrides;
}
