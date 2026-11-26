const RECENT_EVENT_LIMIT = 16;

export type SentencePopoverDismissal =
  | "alignment-changed"
  | "cancel"
  | "invalidated"
  | "outside-press"
  | "preview-blur"
  | "scroll"
  | "source-selection"
  | "toggle"
  | "unmatched"
  | "window-hidden";

type TraceEvent =
  | `dismiss:${SentencePopoverDismissal}`
  | "alignment-validation"
  | "notify-open"
  | "notify-closed"
  | "notify-return"
  | "overlay-render"
  | "popup-cleanup"
  | "source-highlight"
  | "target-highlight"
  | "hover-match";

interface SentencePopoverContext {
  markdown: boolean;
  sourceCollapsed: boolean;
  replacingPopover: boolean;
  resultId: number;
  segmentId: string;
  segmentCount: number;
  resultLength: number;
  scrollRevision: number;
}

export interface SentencePopoverFailure {
  context: SentencePopoverContext;
  counts: Partial<Record<TraceEvent, number>>;
  recent: TraceEvent[];
}

export function createSentencePopoverTrace(report: (failure: SentencePopoverFailure) => void) {
  let active: {
    counts: SentencePopoverFailure["counts"];
    recent: TraceEvent[];
    next: number;
  } | null = null;

  return {
    record(event: TraceEvent) {
      if (!active) return;
      active.counts[event] = (active.counts[event] ?? 0) + 1;
      active.recent[active.next] = event;
      active.next = (active.next + 1) % RECENT_EVENT_LIMIT;
    },
    run(context: SentencePopoverContext, update: () => void) {
      if (active) {
        update();
        return;
      }
      const trace = { counts: {}, recent: [] as TraceEvent[], next: 0 };
      active = trace;
      try {
        update();
      } catch (error) {
        const { counts, recent, next } = trace;
        report({
          context,
          counts,
          recent:
            recent.length === RECENT_EVENT_LIMIT
              ? [...recent.slice(next), ...recent.slice(0, next)]
              : recent,
        });
        throw error;
      } finally {
        active = null;
      }
    },
  };
}
