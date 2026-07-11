// ABOUTME: Coalesces rapid Query invalidations for the same key prefix.
// ABOUTME: Softens bulk mutation event storms (e.g. many model deletes).
export type InvalidateFn = (queryKey: readonly unknown[]) => void;

export type DebouncedInvalidator = {
	schedule: (queryKey: readonly unknown[]) => void;
	flush: () => void;
	cancel: () => void;
};

/**
 * Debounce invalidations by serialized query key. Multiple emits for the same
 * prefix within `delayMs` produce a single invalidate call.
 */
export function createDebouncedInvalidator(invalidate: InvalidateFn, delayMs: number): DebouncedInvalidator {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const pending = new Map<string, readonly unknown[]>();

	function keyId(queryKey: readonly unknown[]): string {
		return JSON.stringify(queryKey);
	}

	function schedule(queryKey: readonly unknown[]) {
		const id = keyId(queryKey);
		pending.set(id, queryKey);
		const existing = timers.get(id);
		if (existing != null) {
			clearTimeout(existing);
		}
		timers.set(
			id,
			setTimeout(() => {
				timers.delete(id);
				const key = pending.get(id);
				pending.delete(id);
				if (key) {
					invalidate(key);
				}
			}, delayMs),
		);
	}

	function flush() {
		for (const timer of timers.values()) {
			clearTimeout(timer);
		}
		timers.clear();
		for (const key of pending.values()) {
			invalidate(key);
		}
		pending.clear();
	}

	function cancel() {
		for (const timer of timers.values()) {
			clearTimeout(timer);
		}
		timers.clear();
		pending.clear();
	}

	return { schedule, flush, cancel };
}
