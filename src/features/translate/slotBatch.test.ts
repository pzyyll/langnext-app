// ABOUTME: Tests for multi-slot cancel isolation and batch outcome shape.
// ABOUTME: Mocks cancel_provider_http; stream starts use empty snapshots for early fail isolation.
import { beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { TranslateInput } from "../../storage/types";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";

installTauriInvokeMock();

const { startSlotStreamBatch, cancelRequestIds } = await import("./slotBatch");
const { runCancelRequestIds } = await import("./runTranslate");

function inputFor(text: string): TranslateInput {
  return {
    modelId: "m1",
    sourceLang: "English",
    targetLang: "Chinese",
    text,
  };
}

const emptySnapshots = {
  providersById: new Map(),
  modelsById: new Map(),
  profile: null,
};

const noopHandlers = {
  onChunk: () => {},
  onReset: () => {},
  onDone: () => {},
  onError: () => {},
};

describe("startSlotStreamBatch", () => {
  test("isolates per-slot early validation without rejecting the batch", async () => {
    const outcomes = await Effect.runPromise(
      startSlotStreamBatch([
        {
          slotId: "s1",
          requestId: "r1",
          input: inputFor("a"),
          snapshots: emptySnapshots,
          handlers: noopHandlers,
        },
        {
          slotId: "s2",
          requestId: "r2",
          input: inputFor("b"),
          snapshots: emptySnapshots,
          handlers: noopHandlers,
        },
      ]),
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });
});

describe("cancelRequestIds", () => {
  beforeEach(() => {
    resetInvokeMock();
    invokeMock.mockImplementation(async () => undefined);
  });

  test("calls both cancel transports for each id and swallows failures", async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "cancel_provider_http") {
        throw { code: "not_found", message: "gone" };
      }
      return false;
    });
    await runCancelRequestIds(["a", "b"]);
    expect(invokeMock.mock.calls.some((c) => c[0] === "cancel_provider_http")).toBe(true);
    expect(invokeMock.mock.calls.some((c) => c[0] === "cancel_provider_runtime")).toBe(true);
    await Effect.runPromise(cancelRequestIds(["c"]));
  });
});
