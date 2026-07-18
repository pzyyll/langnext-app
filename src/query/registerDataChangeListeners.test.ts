// ABOUTME: Behavioral tests for partial listen failure and cancel cleanup.
// ABOUTME: Uses deferred promises so listen resolution order is deterministic.
import { describe, expect, test } from "bun:test";
import { registerDataChangeListeners, type ListenFn } from "./registerDataChangeListeners";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("registerDataChangeListeners", () => {
  test("keeps successful listeners when one listen rejects", async () => {
    const cleaned: string[] = [];
    const errors: string[] = [];

    const listen: ListenFn = async (event) => {
      if (event === "bad") {
        throw new Error("listen failed");
      }
      return () => {
        cleaned.push(event);
      };
    };

    const result = await registerDataChangeListeners({
      listen,
      isCancelled: () => false,
      onError: (event) => {
        errors.push(event);
      },
      events: [
        { name: "good-a", onEvent: () => undefined },
        { name: "bad", onEvent: () => undefined },
        { name: "good-b", onEvent: () => undefined },
      ],
    });

    expect(result.failedEvents).toEqual(["bad"]);
    expect(result.unlisteners).toHaveLength(2);
    expect(errors).toEqual(["bad"]);

    for (const unlisten of result.unlisteners) {
      unlisten();
    }
    expect(cleaned.sort()).toEqual(["good-a", "good-b"]);
  });

  test("unlistens immediately when cancelled after listen resolves", async () => {
    const cleaned: string[] = [];
    const d1 = deferred<() => void>();
    const d2 = deferred<() => void>();
    let call = 0;
    let cancelled = false;

    const listen: ListenFn = async (event) => {
      call += 1;
      if (call === 1) {
        const unlisten = await d1.promise;
        return () => {
          cleaned.push(event);
          unlisten();
        };
      }
      const unlisten = await d2.promise;
      return () => {
        cleaned.push(event);
        unlisten();
      };
    };

    const pending = registerDataChangeListeners({
      listen,
      isCancelled: () => cancelled,
      events: [
        { name: "a", onEvent: () => undefined },
        { name: "b", onEvent: () => undefined },
      ],
    });

    await flushMicrotasks();
    // Resolve first listen, then cancel before second resolves (Strict Mode unmount).
    const unlistenA = () => undefined;
    d1.resolve(unlistenA);
    await flushMicrotasks();
    cancelled = true;
    d2.resolve(() => undefined);
    const result = await pending;

    expect(result.unlisteners).toHaveLength(0);
    // First listener cleaned on per-call cancel; second cleaned the same way.
    expect(cleaned.sort()).toEqual(["a", "b"]);
  });

  test("final cancel pass clears listeners that slipped past per-call checks", async () => {
    const cleaned: string[] = [];
    let cancelled = false;
    let resolveListen!: (unlisten: () => void) => void;

    const listen: ListenFn = async (event) => {
      const unlisten = await new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      });
      return () => {
        cleaned.push(event);
        unlisten();
      };
    };

    const pending = registerDataChangeListeners({
      listen,
      isCancelled: () => cancelled,
      events: [{ name: "late", onEvent: () => undefined }],
    });

    await flushMicrotasks();
    // Flip cancel and resolve in the same turn so the post-await check can race.
    cancelled = true;
    resolveListen(() => undefined);
    const result = await pending;

    expect(result.unlisteners).toHaveLength(0);
    expect(cleaned).toEqual(["late"]);
  });
});
