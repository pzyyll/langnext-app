// ABOUTME: Shared controller for acknowledgement-gated preview confirmation dialogs.
// ABOUTME: Owns load, stale-session cancellation, acknowledgement reset, and confirm gating.
import { useEffect, useState } from "react";

export type UseAcknowledgedPreviewDialogInput<TPreview> = {
  /** When false, the controller stays idle and does not load. */
  active: boolean;
  /** Stable identity for the current preview session; changes reset acknowledgement. */
  sessionKey: string;
  /** Load the preview for the current session. Must not be aborted by the controller. */
  loadPreview: () => Promise<TPreview>;
  /** Localized fallback when the loader throws a non-IPC error shape. */
  fallbackError: string;
  /** Normalize thrown values into a user-visible load error string. */
  formatError: (error: unknown, fallback: string) => string;
};

export type UseAcknowledgedPreviewDialogResult<TPreview> = {
  preview: TPreview | null;
  loading: boolean;
  loadError: string | null;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  confirmDisabled: boolean;
  resetAcknowledgement: () => void;
};

/**
 * Load one preview session, ignore late results after session change/unmount,
 * and gate confirmation until the preview is acknowledged without load errors.
 *
 * Callers should remount the host with `key={sessionKey}` so state starts clean
 * for each session without a synchronous reset effect.
 */
export function useAcknowledgedPreviewDialog<TPreview>(
  input: UseAcknowledgedPreviewDialogInput<TPreview>,
): UseAcknowledgedPreviewDialogResult<TPreview> {
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(input.active));
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!input.active) {
      return;
    }
    let cancelled = false;
    void input
      .loadPreview()
      .then((dto) => {
        if (!cancelled) {
          setPreview(dto);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(input.formatError(error, input.fallbackError));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // sessionKey is the intentional session identity; host remounts on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session-key driven
  }, [input.active, input.sessionKey, input.fallbackError]);

  const resetAcknowledgement = () => {
    setAcknowledged(false);
  };

  return {
    preview,
    loading,
    loadError,
    acknowledged,
    setAcknowledged,
    confirmDisabled: !acknowledged || !preview || loading || Boolean(loadError),
    resetAcknowledgement,
  };
}
