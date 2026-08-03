// ABOUTME: Focused unit tests for the shared AbortSignal-to-cancel wiring.
// ABOUTME: Covers no-signal, pre-aborted, registration-window, single-fire, detach, and async cancel callbacks.
import { describe, expect, test } from "bun:test";
import { attachRequestCancellation } from "./attachRequestCancellation";

describe("attachRequestCancellation", () => {
  test("no signal: returns a no-op detach and never cancels", () => {
    const cancels: string[] = [];
    const detach = attachRequestCancellation("req-1", undefined, (requestId) => {
      cancels.push(requestId);
    });
    expect(cancels).toEqual([]);
    detach();
    expect(cancels).toEqual([]);
  });

  test("pre-aborted signal: cancels exactly once immediately", () => {
    const controller = new AbortController();
    controller.abort();
    const cancels: string[] = [];
    const detach = attachRequestCancellation("req-2", controller.signal, (requestId) => {
      cancels.push(requestId);
    });
    expect(cancels).toEqual(["req-2"]);
    detach();
    expect(cancels).toEqual(["req-2"]);
  });

  test("abort landing between the aborted check and listener attachment still cancels once", () => {
    const controller = new AbortController();
    const realAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    const originalAbort = controller.abort.bind(controller);
    // Reproduce the reviewer's registration window: the abort event fires exactly when
    // the helper tries to attach its listener, i.e. after its initial `aborted` read and
    // before the real listener is registered.
    controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (type === "abort" && !controller.signal.aborted) {
        originalAbort();
      }
      realAddEventListener(type, listener);
    }) as typeof controller.signal.addEventListener;

    const cancels: string[] = [];
    const detach = attachRequestCancellation("req-race", controller.signal, (requestId) => {
      cancels.push(requestId);
    });
    expect(cancels).toEqual(["req-race"]);
    detach();
    controller.abort();
    expect(cancels).toEqual(["req-race"]);
  });

  test("abort during flight: cancels once, detach stops later aborts", () => {
    const controller = new AbortController();
    const cancels: string[] = [];
    const detach = attachRequestCancellation("req-3", controller.signal, (requestId) => {
      cancels.push(requestId);
    });
    controller.abort();
    expect(cancels).toEqual(["req-3"]);
    controller.abort();
    expect(cancels).toEqual(["req-3"]);
    detach();
    controller.abort();
    expect(cancels).toEqual(["req-3"]);
  });

  test("detach before abort: abort does not cancel", () => {
    const controller = new AbortController();
    const cancels: string[] = [];
    const detach = attachRequestCancellation("req-4", controller.signal, (requestId) => {
      cancels.push(requestId);
    });
    detach();
    controller.abort();
    expect(cancels).toEqual([]);
  });

  test("async cancel callback is fired without awaiting it", async () => {
    const controller = new AbortController();
    let called = false;
    const detach = attachRequestCancellation("req-5", controller.signal, async () => {
      called = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(called).toBe(true);
    detach();
  });
});
