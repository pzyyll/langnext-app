// ABOUTME: Pure per-slot epoch helpers for quick-translate stale-work invalidation.
// ABOUTME: Epoch maps are owned by the session hook; pages bump on user edits.
/**
 * Advance the epoch for `slotId` and return the new value.
 * Callers use the returned epoch to tag in-flight work for that card.
 */
export function nextSlotEpoch(epochMap: Map<string, number>, slotId: string): number {
  const next = (epochMap.get(slotId) ?? 0) + 1;
  epochMap.set(slotId, next);
  return next;
}

/** True when `epoch` is still the latest value recorded for `slotId`. */
export function isSlotEpochCurrent(epochMap: Map<string, number>, slotId: string, epoch: number): boolean {
  return epochMap.get(slotId) === epoch;
}

/** Bump every key already present in the map (e.g. unmount invalidation). */
export function bumpAllSlotEpochs(epochMap: Map<string, number>): void {
  for (const slotId of epochMap.keys()) {
    const next = (epochMap.get(slotId) ?? 0) + 1;
    epochMap.set(slotId, next);
  }
}
