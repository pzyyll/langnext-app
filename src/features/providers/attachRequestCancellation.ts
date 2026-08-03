// ABOUTME: Wire an AbortSignal to a best-effort backend cancel call by request id.
// ABOUTME: Shared by the legacy provider HTTP and runtime provider IPC transports.
export type CancelRequest = (requestId: string) => void | Promise<unknown>;

/**
 * Attach one best-effort cancel call to the given AbortSignal: fires `cancel(requestId)`
 * on the first abort event, or immediately when the signal is already aborted. The
 * listener is attached before the `aborted` recheck, so an abort landing between an
 * earlier check and listener registration can never be missed. Returns a detach function
 * that stops further cancellation when the caller no longer needs it (e.g. the request
 * completed). Cancellation is idempotent and never awaited; each transport decides its
 * own error policy inside the passed `cancel` callback.
 */
export function attachRequestCancellation(
  requestId: string,
  signal: AbortSignal | undefined,
  cancel: CancelRequest,
): () => void {
  if (!signal) {
    return () => {};
  }
  let cancelled = false;
  const fire = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    void cancel(requestId);
  };
  signal.addEventListener("abort", fire, { once: true });
  // Recheck after attaching: an abort that fired before/during registration is not
  // dispatched to the new listener, so a synchronous check is required for guarantee.
  if (signal.aborted) {
    fire();
  }
  return () => {
    signal.removeEventListener("abort", fire);
  };
}
