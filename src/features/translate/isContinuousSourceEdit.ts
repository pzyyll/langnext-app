// ABOUTME: Heuristic: progressive source typing vs wholesale replace (select-all/paste).
// ABOUTME: Continuous edits keep prior quick-translate card text; full replaces restart empty.

/**
 * Max code-unit length change still treated as one continuous keystroke / IME commit.
 * Larger one-shot jumps (select-all + retype/paste) restart the output instead of "旧文…".
 */
export const CONTINUOUS_SOURCE_EDIT_MAX_DELTA = 4;

/**
 * Whether `next` looks like progressive editing of `prev` (type/backspace/IME),
 * not a wholesale replace such as select-all then retype or paste.
 * Continuous edits keep prior translation + trailing dots; full replaces restart empty.
 */
export function isContinuousSourceEdit(prev: string, next: string): boolean {
  if (prev === next) {
    return true;
  }
  if (!prev || !next) {
    return false;
  }

  const lengthDelta = Math.abs(prev.length - next.length);

  // Pure append of any size (including paste at end) stays continuous.
  if (next.startsWith(prev)) {
    return true;
  }

  // Small shrink from the end (backspace / delete selection of a few chars).
  if (prev.startsWith(next) && lengthDelta <= CONTINUOUS_SOURCE_EDIT_MAX_DELTA) {
    return true;
  }

  // Small grow/shrink from the start.
  if (next.endsWith(prev)) {
    return true;
  }
  if (prev.endsWith(next) && lengthDelta <= CONTINUOUS_SOURCE_EDIT_MAX_DELTA) {
    return true;
  }

  // Small mid-string edit: limited length delta and mostly-shared prefix.
  if (lengthDelta <= CONTINUOUS_SOURCE_EDIT_MAX_DELTA) {
    const limit = Math.min(prev.length, next.length);
    let shared = 0;
    while (shared < limit && prev[shared] === next[shared]) {
      shared += 1;
    }
    return shared >= limit - CONTINUOUS_SOURCE_EDIT_MAX_DELTA;
  }

  // One-shot replace of most/all content (select-all + retype/paste).
  return false;
}
