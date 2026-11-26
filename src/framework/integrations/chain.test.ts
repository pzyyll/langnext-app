import { expect, test } from "nsh/test";
import { runChain, type ChainStepOutcome } from "./chain";

const retryAll = { continueOn: (_failure: string) => true };

function done<T>(value: T): ChainStepOutcome<T, string> {
  return { kind: "done", value };
}

test("chain: the first done stops the chain", async () => {
  const calls: string[] = [];
  const outcome = await runChain<string, string, string>(
    ["a", "b", "c"],
    async (entry) => {
      calls.push(entry);
      return done(entry);
    },
    retryAll,
  );

  expect(outcome).toEqual({ kind: "done", value: "a" });
  expect(calls).toEqual(["a"]);
});

test("chain: a cancelled step stops immediately", async () => {
  const calls: string[] = [];
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => {
      calls.push(entry);
      return { kind: "cancelled" };
    },
    retryAll,
  );

  expect(outcome).toEqual({ kind: "cancelled" });
  expect(calls).toEqual(["a"]);
});

test("chain: an aborted signal stops before any step", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => {
      calls.push(entry);
      return done(entry);
    },
    retryAll,
    controller.signal,
  );

  expect(outcome).toEqual({ kind: "cancelled" });
  expect(calls).toEqual([]);
});

test("chain: unavailable skips to the next step", async () => {
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => (entry === "a" ? { kind: "unavailable", reason: "ineligible" } : done(entry)),
    retryAll,
  );

  expect(outcome).toEqual({ kind: "done", value: "b" });
});

test("chain: all unavailable reports the first reason", async () => {
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => ({ kind: "unavailable", reason: `${entry}-reason` }),
    retryAll,
  );

  expect(outcome).toEqual({ kind: "unavailable", reason: "a-reason" });
});

test("chain: a retryable failure continues to the next step", async () => {
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => (entry === "a" ? { kind: "failed", failure: "network" } : done(entry)),
    retryAll,
  );

  expect(outcome).toEqual({ kind: "done", value: "b" });
});

test("chain: an exhausted retryable failure returns the last failure", async () => {
  const outcome = await runChain<string, string, string>(
    ["a", "b", "c"],
    async (entry) =>
      entry === "a"
        ? { kind: "unavailable", reason: "ineligible" }
        : entry === "b"
          ? { kind: "failed", failure: "network" }
          : { kind: "failed", failure: "quota" },
    retryAll,
  );

  expect(outcome).toEqual({ kind: "failed", failure: "quota" });
});

test("chain: a non-retryable failure stops immediately", async () => {
  const calls: string[] = [];
  const outcome = await runChain<string, string, string>(
    ["a", "b"],
    async (entry) => {
      calls.push(entry);
      return { kind: "failed", failure: "auth" };
    },
    { continueOn: () => false },
  );

  expect(outcome).toEqual({ kind: "failed", failure: "auth" });
  expect(calls).toEqual(["a"]);
});
