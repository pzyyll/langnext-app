// ABOUTME: App-wide Base UI Toast provider with top-right viewport and variants.
// ABOUTME: Stacks toasts by default; expands the stack on viewport hover/focus.
import type { ComponentType, ReactNode, SVGProps } from "react";
import { Toast } from "@base-ui/react/toast";
import IconMaterialSymbolsLightCheckCircle from "~icons/material-symbols-light/check-circle";
import IconMaterialSymbolsLightError from "~icons/material-symbols-light/error";
import IconMaterialSymbolsLightWarning from "~icons/material-symbols-light/warning";
import IconMaterialSymbolsLightInfo from "~icons/material-symbols-light/info";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import { iconButtonClassName } from "../ui";
import type { ToastVariant } from "./useToast";

/**
 * Fixed top-right stack, below the titlebar (titlebar-height).
 * Absolute children stack inside; Base UI sets data-expanded on hover/focus.
 */
const toastViewportClassName = "fixed top-10 right-4 z-50 w-sm max-w-[calc(100vw-2rem)] outline-none";

/**
 * Collapsed stack + expanded list (Base UI stacking CSS vars).
 * Peeks behind toasts; expands with --toast-offset-y when data-expanded.
 * Frame chrome: outline + shadow-frame; enter/exit from the right.
 */
const toastRootClassName = [
	"[--gap:0.5rem]",
	"[--peek:0.75rem]",
	"[--scale:calc(max(0,1-(var(--toast-index)*0.1)))]",
	"[--shrink:calc(1-var(--scale))]",
	"[--height:var(--toast-frontmost-height,var(--toast-height))]",
	"[--offset-y:calc(var(--toast-offset-y)+(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))]",
	"absolute top-0 right-0 left-auto z-[calc(1000-var(--toast-index))] w-full origin-top",
	"[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))]",
	"h-[var(--height)] border border-line bg-surface text-on-surface shadow-frame select-none",
	"after:absolute after:bottom-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
	"data-expanded:h-[var(--toast-height)]",
	"data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
	"data-limited:pointer-events-none data-limited:opacity-0",
	"data-starting-style:[transform:translateX(150%)]",
	"[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateX(150%)]",
	"data-ending-style:opacity-0",
	"data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
	"data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
	"data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
	"data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
	"data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
	"data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
	"data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
	"data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
	"[transition:transform_0.5s_cubic-bezier(0.22,1,0.36,1),opacity_0.5s,height_0.15s]",
	"motion-reduce:transition-none",
	"focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-on-surface",
].join(" ");

/** Hides overflow while collapsed; reveals behind toasts when the stack expands. */
const toastContentClassName =
	"flex h-full min-w-0 items-start gap-3 overflow-hidden p-3 transition-opacity duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100 motion-reduce:transition-none";

const toastTitleClassName = "text-body-bold font-bold text-on-surface";
const toastDescriptionClassName = "text-body-tight text-neutral";

type StatusIcon = ComponentType<SVGProps<SVGSVGElement>>;

const VARIANT_ICON: Record<ToastVariant, StatusIcon> = {
	success: IconMaterialSymbolsLightCheckCircle,
	error: IconMaterialSymbolsLightError,
	warning: IconMaterialSymbolsLightWarning,
	info: IconMaterialSymbolsLightInfo,
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
	success: "size-5 shrink-0 text-tertiary",
	error: "size-5 shrink-0 text-error",
	warning: "size-5 shrink-0 text-on-surface",
	info: "size-5 shrink-0 text-tertiary",
};

const VARIANT_ACCENT_BAR: Record<ToastVariant, string> = {
	success: "border-l-2 border-l-accent",
	error: "border-l-2 border-l-danger",
	warning: "border-l-2 border-l-ink",
	info: "border-l-2 border-l-accent",
};

function isToastVariant(type: string | undefined): type is ToastVariant {
	return type === "success" || type === "error" || type === "warning" || type === "info";
}

function ToastList() {
	const { toasts } = Toast.useToastManager();

	return toasts.map((toast) => {
		const variant: ToastVariant = isToastVariant(toast.type) ? toast.type : "info";
		const Icon = VARIANT_ICON[variant];

		return (
			<Toast.Root
				key={toast.id}
				toast={toast}
				swipeDirection="right"
				className={`${toastRootClassName} ${VARIANT_ACCENT_BAR[variant]}`}
			>
				<Toast.Content className={toastContentClassName}>
					<Icon className={VARIANT_ICON_CLASS[variant]} aria-hidden />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<Toast.Title className={toastTitleClassName} />
						<Toast.Description className={toastDescriptionClassName} />
					</div>
					<Toast.Close className={iconButtonClassName} aria-label="Dismiss notification">
						<IconMaterialSymbolsLightClose className="size-4" aria-hidden />
					</Toast.Close>
				</Toast.Content>
			</Toast.Root>
		);
	});
}

export type ToastProviderProps = {
	children: ReactNode;
};

/**
 * Mount once at the app root (around the router) so `useToast` works everywhere.
 * Renders a portaled viewport in the top-right corner.
 */
export function ToastProvider({ children }: ToastProviderProps) {
	return (
		<Toast.Provider timeout={4000} limit={5}>
			{children}
			<Toast.Portal>
				<Toast.Viewport className={toastViewportClassName}>
					<ToastList />
				</Toast.Viewport>
			</Toast.Portal>
		</Toast.Provider>
	);
}
