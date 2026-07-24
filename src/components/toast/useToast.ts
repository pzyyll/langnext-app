// ABOUTME: Convenience hook over Base UI Toast.useToastManager for app feedback.
// ABOUTME: Exposes success/error/warning/info helpers with project default durations.
import { useEffect, useMemo, useRef } from "react";
import { Toast } from "@base-ui/react/toast";

/** Visual / semantic toast variants used across the app. */
export type ToastVariant = "success" | "error" | "warning" | "info";

/** Optional action button shown inside a toast (e.g. Open Plugins). */
export type ToastActionOptions = {
  label: string;
  onClick: () => void;
};

/** Payload for a single toast notification. */
export type ToastShowOptions = {
  /** Short headline shown as the toast title. */
  title: string;
  /** Optional supporting detail under the title. */
  description?: string;
  /** Auto-dismiss timeout in ms; omit for variant defaults. `0` disables auto-dismiss. */
  duration?: number;
  /** Optional recovery/control action rendered via Base UI Toast.Action. */
  action?: ToastActionOptions;
};

/** Options for `toast.show`, including the variant. */
export type ToastShowWithVariantOptions = ToastShowOptions & {
  variant: ToastVariant;
};

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 5000,
  error: 6000,
};

export type ToastApi = {
  /** Show a toast with an explicit variant. Returns the toast id. */
  show: (options: ToastShowWithVariantOptions) => string;
  /** Success feedback (default 4000ms, polite priority). */
  success: (options: ToastShowOptions) => string;
  /** Error feedback (default 6000ms, assertive/high priority). */
  error: (options: ToastShowOptions) => string;
  /** Warning feedback (default 5000ms). */
  warning: (options: ToastShowOptions) => string;
  /** Informational feedback (default 4000ms). */
  info: (options: ToastShowOptions) => string;
  /** Dismiss a toast by id, or the frontmost when omitted. */
  close: (toastId?: string) => void;
};

/**
 * App-facing toast API. Must be used under `ToastProvider`.
 *
 * @example
 * const toast = useToast();
 * toast.success({ title: "Synced models", description: result.message });
 * toast.error({ title: "Sync failed", description: message });
 */
export function useToast(): ToastApi {
  const manager = Toast.useToastManager();
  // Keep a stable ToastApi identity across renders so callbacks that depend on
  // `toast` (e.g. auto-translate effects) do not thrash every state update.
  // The manager object changes on every toast list mutation, so we mirror it
  // into a ref inside an effect (not during render) to keep the API stable.
  const managerRef = useRef(manager);
  useEffect(() => {
    managerRef.current = manager;
  }, [manager]);

  return useMemo(() => {
    function show(options: ToastShowWithVariantOptions): string {
      const { variant, title, description, duration, action } = options;
      const autoTimeout = duration ?? DEFAULT_DURATION_MS[variant];
      const id = managerRef.current.add({
        type: variant,
        title,
        description,
        timeout: autoTimeout,
        priority: variant === "error" ? "high" : "low",
        actionProps: action
          ? {
              children: action.label,
              onClick: action.onClick,
            }
          : undefined,
      });
      // Base UI pauses the internal close timer whenever the viewport is
      // expanded (hover/focus) or the window is blurred. In a stacked viewport
      // that pause path can keep stacked toasts from ever starting their timer,
      // so they linger until manually closed. Schedule an independent close so
      // the duration is honored regardless; `close(id)` is a no-op once the
      // toast has already been removed. `duration: 0` stays an opt-out.
      if (autoTimeout > 0) {
        setTimeout(() => managerRef.current.close(id), autoTimeout);
      }
      return id;
    }

    return {
      show,
      success: (options) => show({ ...options, variant: "success" }),
      error: (options) => show({ ...options, variant: "error" }),
      warning: (options) => show({ ...options, variant: "warning" }),
      info: (options) => show({ ...options, variant: "info" }),
      close: (toastId) => managerRef.current.close(toastId),
    };
  }, []);
}
