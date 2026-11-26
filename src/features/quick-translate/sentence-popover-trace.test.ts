import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";
import { createSentencePopoverTrace, type SentencePopoverFailure } from "./sentence-popover-trace";

test("sentence popover trace: reports a bounded record only when a reactive update fails", () => {
  const failures: SentencePopoverFailure[] = [];
  const trace = createSentencePopoverTrace((failure) => failures.push(failure));
  const context = {
    markdown: true,
    sourceCollapsed: true,
    replacingPopover: false,
    resultId: 2,
    segmentId: "seg-3",
    segmentCount: 5,
    resultLength: 640,
    scrollRevision: 7,
  };
  trace.run(context, () => trace.record("overlay-render"));
  expect(failures).toEqual([]);

  const revision = signal(0);
  effect(() => {
    const next = revision();
    if (next === 0) return;
    trace.record("alignment-validation");
    revision.set(next + 1);
  });
  let original: unknown;
  let propagated: unknown;
  try {
    trace.run(context, () => {
      trace.record("notify-open");
      try {
        revision.set(1);
      } catch (error) {
        original = error;
        trace.record("notify-return");
        throw error;
      }
    });
  } catch (error) {
    propagated = error;
  }

  expect(String(original)).toContain("potential infinite loop");
  expect(propagated).toBe(original);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.context).toEqual(context);
  expect(failures[0]?.counts["notify-open"]).toBe(1);
  expect(failures[0]?.counts["overlay-render"]).toBeUndefined();
  expect(failures[0]?.counts["alignment-validation"]).toBeGreaterThan(16);
  expect(failures[0]?.recent).toHaveLength(16);
  expect(failures[0]?.recent.slice(-2)).toEqual(["alignment-validation", "notify-return"]);
});
