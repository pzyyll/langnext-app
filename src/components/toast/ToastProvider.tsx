// ABOUTME: App-wide Base UI Toast provider with top-right viewport and variants.
// ABOUTME: Portals notifications above chrome; pairs with useToast for call-site API.
import type { ComponentType, ReactNode, SVGProps } from "react";
import { Toast } from "@base-ui/react/toast";
import IconMaterialSymbolsLightCheckCircle from "~icons/material-symbols-light/check-circle";
import IconMaterialSymbolsLightError from "~icons/material-symbols-light/error";
import IconMaterialSymbolsLightWarning from "~icons/material-symbols-light/warning";
import IconMaterialSymbolsLightInfo from "~icons/material-symbols-light/info";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import { iconButtonClassName } from "../ui";
import type { ToastVariant } from "./useToast";

/** Fixed top-right stack, below the titlebar (h-8), above app chrome. */
const toastViewportClassName =
	"pointer-events-none fixed top-10 right-4 z-50 flex w-sm max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none";

/**
 * Frame toast: outline + shadow-frame, enter/exit from the right.
 * Base UI sets data-starting-style / data-ending-style during open/close.
 */
const toastRootClassName =
	"pointer-events-auto relative w-full border border-line bg-surface p-3 text-ink shadow-frame transition-[transform,opacity] duration-150 ease-out select-none data-starting-style:translate-x-full data-starting-style:opacity-0 data-ending-style:translate-x-full data-ending-style:opacity-0 data-limited:pointer-events-none data-limited:opacity-0 motion-reduce:transition-none motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-starting-style:opacity-100 motion-reduce:data-ending-style:translate-x-0 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ink";

const toastTitleClassName = "text-sm font-bold leading-5 text-ink";
const toastDescriptionClassName = "text-sm leading-5 text-muted";

type StatusIcon = ComponentType<SVGProps<SVGSVGElement>>;

const VARIANT_ICON: Record<ToastVariant, StatusIcon> = {
	success: IconMaterialSymbolsLightCheckCircle,
	error: IconMaterialSymbolsLightError,
	warning: IconMaterialSymbolsLightWarning,
	info: IconMaterialSymbolsLightInfo,
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
	success: "size-5 shrink-0 text-accent",
	error: "size-5 shrink-0 text-danger",
	warning: "size-5 shrink-0 text-ink",
	info: "size-5 shrink-0 text-accent",
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
				<Toast.Content className="flex min-w-0 flex-1 items-start gap-3">
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
