// ABOUTME: Pure helpers for optimistic provider reorder and safe rollback.
// ABOUTME: Keeps concurrent-mutation epoch checks out of React components.
/**
 * Reorder a provider list by id sequence. Returns null when the id set does not
 * match the previous list (incomplete or extra ids) so callers skip the write.
 */
export function applyProviderReorderOrder<T extends { id: string }>(
	previous: readonly T[],
	orderedIds: readonly string[],
): T[] | null {
	if (orderedIds.length !== previous.length) {
		return null;
	}
	const byId = new Map(previous.map((item) => [item.id, item]));
	const next: T[] = [];
	for (const id of orderedIds) {
		const item = byId.get(id);
		if (!item) {
			return null;
		}
		next.push(item);
		byId.delete(id);
	}
	if (byId.size !== 0) {
		return null;
	}
	return next;
}

/**
 * Rollback an optimistic reorder only when this mutation is still the latest
 * in-flight epoch. A newer successful reorder must not be overwritten.
 */
export function shouldRollbackReorder(mutationEpoch: number, latestEpoch: number): boolean {
	return mutationEpoch === latestEpoch;
}
