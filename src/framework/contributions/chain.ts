// ABOUTME: One deterministic fallback chain for OCR and language detection.
// ABOUTME: Stops on done, cancellation, or a non-retryable failure; keeps the last failure.

/** One step's result: the value, a skip, a retryable-or-not failure, or cancellation. */
export type ChainStepOutcome<T, F = string> =
  | { kind: "done"; value: T }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: F }
  | { kind: "failed"; failure: F };

/** Decides whether a failure lets the next entry run. */
export interface ChainPolicy<F = string> {
  continueOn(failure: F): boolean;
}

/** The chain's result; `unavailable` carries the first reason, `failed` the last failure. */
export type ChainOutcome<T, F = string> =
  | { kind: "done"; value: T }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: F | null }
  | { kind: "failed"; failure: F };

function cancelled<T, F>(): ChainOutcome<T, F> {
  return { kind: "cancelled" };
}

/**
 * Runs entries in order until one succeeds, cancellation stops the chain, or a
 * failure the policy does not retry is reported. When every entry is unavailable
 * or retryably failed, the last failure wins over the first unavailable reason.
 */
export async function runChain<T, F, E>(
  entries: readonly E[],
  run: (entry: E) => ChainStepOutcome<T, F> | Promise<ChainStepOutcome<T, F>>,
  policy: ChainPolicy<F>,
  signal?: AbortSignal,
): Promise<ChainOutcome<T, F>> {
  let firstUnavailable: F | null = null;
  let lastFailure: F | null = null;

  for (const entry of entries) {
    if (signal?.aborted) return cancelled();
    const outcome = await run(entry);
    if (signal?.aborted) return cancelled();
    if (outcome.kind === "done") return { kind: "done", value: outcome.value };
    if (outcome.kind === "cancelled") return cancelled();
    if (outcome.kind === "unavailable") {
      firstUnavailable ??= outcome.reason;
      continue;
    }
    lastFailure = outcome.failure;
    if (!policy.continueOn(outcome.failure)) {
      return { kind: "failed", failure: outcome.failure };
    }
  }

  if (lastFailure !== null) return { kind: "failed", failure: lastFailure };
  return { kind: "unavailable", reason: firstUnavailable };
}
