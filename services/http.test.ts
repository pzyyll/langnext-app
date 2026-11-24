import { expect, test } from "nsh/test";
import { createHttpFetch, type HttpRequestInit } from "./http";

type Level = "debug" | "info" | "warn" | "error";

interface Captured {
  calls: unknown[][];
  restore(): void;
}

/** Replaces one `console` method so a test reads what the transport logged. */
function capture(level: Level): Captured {
  const calls: unknown[][] = [];
  const methods = console as unknown as Record<Level, (...data: unknown[]) => void>;
  const original = methods[level];
  methods[level] = (...data: unknown[]) => {
    calls.push(data);
  };
  return {
    calls,
    restore: () => {
      methods[level] = original;
    },
  };
}

const CHAT_URL = "https://api.example.com/v1/chat";

function call(body?: string, signal = new AbortController().signal): HttpRequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body }),
    signal,
  };
}

test("http transport: logs the request, the status, and the body the caller reads", async () => {
  const info = capture("info");
  const debug = capture("debug");
  const client = createHttpFetch({
    scope: "ai/http",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ choices: [] }),
    }),
  });

  let payload: unknown;
  try {
    const response = await client(CHAT_URL, call('{"model":"m"}'));
    payload = await response.json();
  } finally {
    info.restore();
    debug.restore();
  }

  expect(payload).toEqual({ choices: [] });
  expect(info.calls).toEqual([
    [`[ai/http] request POST ${CHAT_URL}`],
    [`[ai/http] response 200 POST ${CHAT_URL}`],
  ]);
  expect(debug.calls).toEqual([
    [`[ai/http] request body POST ${CHAT_URL} body={"model":"m"}`],
    [`[ai/http] response body 200 POST ${CHAT_URL} body={"choices":[]}`],
  ]);
});

test("http transport: counts a binary body and previews a text one", async () => {
  const info = capture("info");
  const debug = capture("debug");
  const streamOf = (chunks: readonly number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        controller.close();
      },
    });
  const client = (type: string, chunks: readonly number[][]) =>
    createHttpFetch({
      scope: "tts/azure",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => type },
        json: async () => ({}),
        body: streamOf(chunks),
      }),
    });

  try {
    const audio = await client("audio/mpeg", [[1, 2]])(CHAT_URL, call());
    const audioReader = audio.body!.getReader();
    while (!(await audioReader.read()).done) {
      // Drain the body so the transport reports it.
    }

    const events = await client("text/event-stream", [[100, 97, 116, 97, 58, 32, 49, 10, 10]])(
      CHAT_URL,
      call(),
    );
    const eventReader = events.body!.getReader();
    while (!(await eventReader.read()).done) {
      // Drain the body so the transport reports it.
    }
  } finally {
    info.restore();
    debug.restore();
  }

  expect(debug.calls).toEqual([
    [`[tts/azure] response body 200 POST ${CHAT_URL} body={"streamedBytes":2}`],
    [
      `[tts/azure] response body 200 POST ${CHAT_URL}` +
        ' body={"streamedBytes":9,"streamedChars":9,"preview":"data: 1\\n\\n"}',
    ],
  ]);
});

test("http transport: a transport failure is an error line and rejects as it came", async () => {
  const error = capture("error");
  const boom = new TypeError("fetch failed");
  const client = createHttpFetch({
    scope: "ocr/baidu",
    fetchImpl: async () => {
      throw boom;
    },
  });

  let caught: unknown;
  try {
    await client(CHAT_URL, call());
  } catch (thrown) {
    caught = thrown;
  } finally {
    error.restore();
  }

  expect(caught).toBe(boom);
  expect(error.calls).toEqual([
    [`[ocr/baidu] failure POST ${CHAT_URL} error=TypeError: fetch failed`],
  ]);
});

test("http transport: a stopped call is debug and a caller can own the failure line", async () => {
  const error = capture("error");
  const debug = capture("debug");
  const controller = new AbortController();
  controller.abort();
  const stopped = createHttpFetch({
    scope: "ai/http",
    fetchImpl: async () => {
      throw new Error("stopped");
    },
  });
  const owned = createHttpFetch({
    scope: "ai/http",
    logFailures: false,
    fetchImpl: async () => {
      throw new Error("mapped above this layer");
    },
  });

  try {
    await stopped(CHAT_URL, call(undefined, controller.signal)).catch(() => {});
    await owned(CHAT_URL, call()).catch(() => {});
  } finally {
    error.restore();
    debug.restore();
  }

  expect(error.calls).toEqual([]);
  expect(debug.calls).toEqual([[`[ai/http] aborted POST ${CHAT_URL}`]]);
});

test("http transport: a bundled asset read stays out of the log", async () => {
  const info = capture("info");
  const debug = capture("debug");
  const client = createHttpFetch({
    scope: "models-dev/catalog",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    }),
  });

  let body: string;
  try {
    const response = await client("asset:/catalog/models.dev.json", call());
    body = await response.text!();
  } finally {
    info.restore();
    debug.restore();
  }

  expect(body).toBe("{}");
  expect(info.calls).toEqual([]);
  expect(debug.calls).toEqual([]);
});
