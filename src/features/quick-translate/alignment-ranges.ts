export interface TextRange {
  start: number;
  end: number;
}

export interface SentenceSegment extends TextRange {
  id: string;
  testID?: string;
}

export interface SentenceFragment extends TextRange {
  segment?: SentenceSegment;
  comparisonId?: string;
}

/** Split at both sets of boundaries so each fragment retains its own press target. */
export function composeSentenceFragments(
  segments: readonly SentenceSegment[],
  comparison: readonly SentenceSegment[],
): SentenceFragment[] {
  if (comparison.length === 0) return segments.map((segment) => ({ ...segment, segment }));

  const boundaries = [
    ...new Set([...segments, ...comparison].flatMap(({ start, end }) => [start, end])),
  ].sort((a, b) => a - b);
  const fragments: SentenceFragment[] = [];
  let segmentIndex = 0;
  let comparisonIndex = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = boundaries[index - 1]!;
    const end = boundaries[index]!;
    while (segments[segmentIndex] && segments[segmentIndex]!.end <= start) segmentIndex += 1;
    while (comparison[comparisonIndex] && comparison[comparisonIndex]!.end <= start)
      comparisonIndex += 1;
    const segment = segments[segmentIndex];
    const reference = comparison[comparisonIndex];
    const interactive = segment && segment.start <= start ? segment : undefined;
    const comparisonId = reference && reference.start <= start ? reference.id : undefined;
    if (interactive || comparisonId) {
      fragments.push({ start, end, segment: interactive, comparisonId });
    }
  }
  return fragments;
}

export function fragmentTestId(
  testID: string | undefined,
  counters: Map<string, number>,
): string | undefined {
  if (!testID) return undefined;
  const index = counters.get(testID) ?? 0;
  counters.set(testID, index + 1);
  return index === 0 ? testID : `${testID}-frag-${index}`;
}
