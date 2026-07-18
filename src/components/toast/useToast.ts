// ABOUTME: Convenience hook over Base UI Toast.useToastManager for app feedback.
// ABOUTME: Exposes success/error/warning/info helpers with project default durations.
import { Toast } from "@base-ui/react/toast";

/** Visual / semantic toast variants used across the app. */
export type ToastVariant = "success" | "error" | "warning" | "info";

/** Payload for a single toast notification. */
export type ToastShowOptions = {
  /** Short headline shown as the toast title. */
  title: string;
  /** Optional supporting detail under the title. */
  description?: string;
  /** Auto-dismiss timeout in ms; omit for variant defaults. `0` disables auto-dismiss. */
  duration?: number;
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

  function show(options: ToastShowWithVariantOptions): string {
    const { variant, title, description, duration } = options;
    return manager.add({
      type: variant,
      title,
      description,
      timeout: duration ?? DEFAULT_DURATION_MS[variant],
      priority: variant === "error" ? "high" : "low",
    });
  }

  return {
    show,
    success: (options) => show({ ...options, variant: "success" }),
    error: (options) => show({ ...options, variant: "error" }),
    warning: (options) => show({ ...options, variant: "warning" }),
    info: (options) => show({ ...options, variant: "info" }),
    close: (toastId) => manager.close(toastId),
  };
}
