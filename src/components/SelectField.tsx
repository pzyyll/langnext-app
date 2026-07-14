// ABOUTME: Styled Base UI Select wrapper matching the project's outline/frame design tokens.
// ABOUTME: Supports compact variant, disabled options, orphaned items, and placeholder text.

import { useMemo } from "react";
import { Select } from "@base-ui/react/select";

export type SelectOption = {
	value: string;
	label: string;
	disabled?: boolean;
};

export type SelectFieldProps = {
	id?: string;
	/** Extra trigger classes merged onto the base outline styles (does not replace layout). */
	className?: string;
	value: string;
	onValueChange: (value: string | null) => void;
	options: SelectOption[];
	disabled?: boolean;
	placeholder?: string;
	/** Extra items kept selectable when absent from the main options list (e.g. orphaned ids). */
	extraOptions?: SelectOption[];
	/** Omit w-full for inline / toolbar selects. */
	compact?: boolean;
	"aria-label"?: string;
	"aria-labelledby"?: string;
};

function CaretUpDownIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="currentColor"
			className="pointer-events-none shrink-0"
			style={{ display: "block" }}
		>
			<path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			className="pointer-events-none shrink-0"
			style={{ display: "block" }}
		>
			<path d="m2.5 8.5 4 4 7-9" />
		</svg>
	);
}

const triggerBase =
	"flex h-control-height items-center justify-between gap-2 select-none rounded-none border border-line bg-surface px-3 text-body-tight font-normal text-on-surface hover:not-data-disabled:bg-surface-2 data-popup-open:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface data-disabled:border-disabled data-disabled:text-disabled";

const popupClassName =
	"min-w-[var(--anchor-width)] origin-[var(--transform-origin)] border border-line bg-surface text-on-surface shadow-frame transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

const itemClassName =
	"grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-1.5 pr-3 pl-2.5 text-body-tight outline-hidden select-none data-highlighted:bg-on-surface data-highlighted:text-surface data-disabled:text-disabled";

export function SelectField({
	id,
	className,
	value,
	onValueChange,
	options,
	disabled = false,
	placeholder,
	extraOptions,
	compact = false,
	"aria-label": ariaLabel,
	"aria-labelledby": ariaLabelledby,
}: SelectFieldProps) {
	const allOptions = useMemo(() => {
		if (!extraOptions || extraOptions.length === 0) return options;
		const existingValues = new Set(options.map((option) => option.value));
		const uniqueExtras = extraOptions.filter((option) => !existingValues.has(option.value));
		return [...options, ...uniqueExtras];
	}, [options, extraOptions]);

	// Always keep triggerBase (flex + icon alignment); className only adds/overrides extras.
	const triggerClassName = [compact ? triggerBase : `${triggerBase} w-full`, className]
		.filter(Boolean)
		.join(" ");

	return (
		<Select.Root value={value} onValueChange={onValueChange} items={allOptions} disabled={disabled}>
			<Select.Trigger
				id={id}
				className={triggerClassName}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledby}
			>
				<Select.Value
					placeholder={placeholder}
					className="min-w-0 flex-1 truncate data-placeholder:text-neutral"
				/>
				<Select.Icon>
					<CaretUpDownIcon />
				</Select.Icon>
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					className="outline-hidden z-50 select-none"
					alignItemWithTrigger={false}
					side="bottom"
					align="start"
					sideOffset={4}
				>
					<Select.Popup className={popupClassName}>
						<Select.List className="max-h-[var(--available-height)] overflow-y-auto py-1 scroll-py-1">
							{allOptions.map((option) => (
								<Select.Item
									key={option.value}
									value={option.value}
									disabled={option.disabled}
									className={itemClassName}
								>
									<Select.ItemIndicator className="col-start-1">
										<CheckIcon />
									</Select.ItemIndicator>
									<Select.ItemText className="col-start-2 truncate">{option.label}</Select.ItemText>
								</Select.Item>
							))}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
