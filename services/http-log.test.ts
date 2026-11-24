import { expect, test } from "nsh/test";
import { createHttpLog, HTTP_LOG_PAYLOAD_LIMIT } from "./http-log";

type Level = "debug" | "info" | "warn" | "error";

interface Captured {
  calls: unknown[][];
  restore(): void;
}

/** Replaces one `console` method so a test reads what the HTTP log wrote. */
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

test("http-log: the request line keeps the endpoint and masks its credentials", () => {
  const httpLog = createHttpLog("ocr/baidu");
  const info = capture("info");
  try {
    httpLog.request(
      "POST",
      "https://aip.baidubce.com/rest/2.0/ocr/v1/general?access_token=abc123",
      '{"api_key":"key-1","image":"AA=="}',
    );
    httpLog.request(
      "POST",
      "https://aip.baidubce.com/oauth/2.0/token",
      "grant_type=client_credentials&client_id=id-1&client_secret=s3cret",
    );
  } finally {
    info.restore();
  }

  expect(info.calls).toEqual([
    [
      "[ocr/baidu] request POST https://aip.baidubce.com/rest/2.0/ocr/v1/general?access_token=***" +
        ' body={"api_key":"***","image":"AA=="}',
    ],
    [
      "[ocr/baidu] request POST https://aip.baidubce.com/oauth/2.0/token" +
        " body=grant_type=client_credentials&client_id=id-1&client_secret=***",
    ],
  ]);
});

test("http-log: a 2xx answer is info and a rejected answer is an error", () => {
  const httpLog = createHttpLog("ai/http");
  const info = capture("info");
  const error = capture("error");
  const url = "https://api.openai.com/v1/chat/completions";
  try {
    httpLog.response("POST", url, 200, { choices: [{ message: { content: "hi" } }] });
    httpLog.response("POST", url, 400, { error: { message: "bad model" } });
  } finally {
    info.restore();
    error.restore();
  }

  expect(info.calls).toEqual([
    [`[ai/http] response 200 POST ${url} body={"choices":[{"message":{"content":"hi"}}]}`],
  ]);
  expect(error.calls).toEqual([
    [`[ai/http] response 400 POST ${url} body={"error":{"message":"bad model"}}`],
  ]);
});

test("http-log: the failure line keeps the provider category and the answer body", () => {
  const httpLog = createHttpLog("ai/http");
  const error = capture("error");
  const failure = Object.assign(new Error("rejected"), {
    name: "ProviderProtocolError",
    kind: "invalid_request",
    status: 400,
  });
  try {
    httpLog.failure(
      "POST",
      "https://api.openai.com/v1/chat/completions",
      failure,
      '{"message":"no such model"}',
    );
  } finally {
    error.restore();
  }

  expect(error.calls).toEqual([
    [
      "[ai/http] failure POST https://api.openai.com/v1/chat/completions" +
        " error=ProviderProtocolError: rejected kind=invalid_request status=400" +
        ' body={"message":"no such model"}',
    ],
  ]);
});

test("http-log: a cancelled request is debug, never an error", () => {
  const httpLog = createHttpLog("ai/http");
  const error = capture("error");
  const debug = capture("debug");
  const cancelled = Object.assign(new Error("stopped"), {
    name: "ProviderProtocolError",
    kind: "cancelled",
  });
  try {
    httpLog.failure("POST", "https://api.openai.com/v1/chat/completions", cancelled);
  } finally {
    error.restore();
    debug.restore();
  }

  expect(error.calls).toEqual([]);
  expect(debug.calls).toHaveLength(1);
});

test("http-log: a long payload keeps its head and states the dropped size", () => {
  const httpLog = createHttpLog("ai/http");
  const info = capture("info");
  try {
    httpLog.request("POST", "https://api.example.com/v1", "x".repeat(HTTP_LOG_PAYLOAD_LIMIT + 10));
  } finally {
    info.restore();
  }

  expect(info.calls).toEqual([
    [
      `[ai/http] request POST https://api.example.com/v1 body=${"x".repeat(HTTP_LOG_PAYLOAD_LIMIT)}…(+10 chars)`,
    ],
  ]);
});
