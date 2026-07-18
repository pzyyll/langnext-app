// ABOUTME: Behavioral tests for ordered theme mutation queue and rollback rules.
// ABOUTME: Uses deferred promises to force deterministic backend completion order.
import { describe, expect, test } from "bun:test";
import { ThemeMutationQueue, type ThemeMode } from "./themeMutationQueue";

function deferred<T = void>() {
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

describe("ThemeMutationQueue", () => {
  test("two rapid successful writes invoke backend in click order", async () => {
    const order: ThemeMode[] = [];
    const d1 = deferred();
    const d2 = deferred();
    let call = 0;

    const queue = new ThemeMutationQueue({
      persist: async (mode) => {
        order.push(mode);
        call += 1;
        if (call === 1) await d1.promise;
        else await d2.promise;
      },
    });

    queue.enqueue("dark");
    queue.enqueue("light");
    await flushMicrotasks();

    // First request is waiting; second must not have started.
    expect(order).toEqual(["dark"]);

    d1.resolve();
    await flushMicrotasks();
    expect(order).toEqual(["dark", "light"]);

    d2.resolve();
    await queue.drain();
    expect(order).toEqual(["dark", "light"]);
  });

  test("first failure followed by success reports only failure then success", async () => {
    const events: string[] = [];
    const d1 = deferred();
    const d2 = deferred();
    let call = 0;

    const queue = new ThemeMutationQueue({
      persist: async (mode) => {
        call += 1;
        if (call === 1) {
          await d1.promise;
          throw new Error("persist failed");
        }
        await d2.promise;
        void mode;
      },
      onSuccess: (mode, id) => events.push(`ok:${mode}:${id}`),
      onFailure: (mode, id) => events.push(`fail:${mode}:${id}`),
    });

    const id1 = queue.enqueue("dark");
    const id2 = queue.enqueue("light");
    expect(id1).toBe(1);
    expect(id2).toBe(2);

    d1.resolve();
    await flushMicrotasks();
    expect(events).toEqual(["fail:dark:1"]);

    d2.resolve();
    await queue.drain();
    expect(events).toEqual(["fail:dark:1", "ok:light:2"]);
  });

  test("stale failure after newer optimistic action still reports but consumer can ignore", async () => {
    const failures: number[] = [];
    const d1 = deferred();
    const d2 = deferred();
    let call = 0;

    const queue = new ThemeMutationQueue({
      persist: async () => {
        call += 1;
        if (call === 1) {
          await d1.promise;
          throw new Error("stale fail");
        }
        await d2.promise;
      },
      onFailure: (_mode, id) => failures.push(id),
    });

    queue.enqueue("dark");
    queue.enqueue("light");
    await flushMicrotasks();

    d1.resolve();
    await flushMicrotasks();
    // Failure for mutation 1 arrives after mutation 2 is already latest.
    expect(failures).toEqual([1]);
    expect(queue.latestMutationId).toBe(2);

    d2.resolve();
    await queue.drain();
  });
});
