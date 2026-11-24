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

test("http-log: the request line keeps the endpoint and its body waits for debug", () => {
  const httpLog = createHttpLog("ocr/baidu");
  const cameraUrl = "https://aip.baidubce.com/rest/2.0/ocr/v1/general?access_token=abc123";
  const tokenUrl = "https://aip.baidubce.com/oauth/2.0/token";
  const info = capture("info");
  const debug = capture("debug");
  try {
    httpLog.request("POST", cameraUrl, '{"api_key":"key-1","image":"AA=="}');
    httpLog.request(
      "POST",
      tokenUrl,
      "grant_type=client_credentials&client_id=id-1&client_secret=s3cret",
    );
  } finally {
    info.restore();
    debug.restore();
  }

  const maskedUrl = cameraUrl.replace("abc123", "***");
  expect(info.calls).toEqual([
    [`[ocr/baidu] request POST ${maskedUrl}`],
    [`[ocr/baidu] request POST ${tokenUrl}`],
  ]);
  expect(debug.calls).toEqual([
    [`[ocr/baidu] request body POST ${maskedUrl} body={"api_key":"***","image":"AA=="}`],
    [
      `[ocr/baidu] request body POST ${tokenUrl}` +
        " body=grant_type=client_credentials&client_id=id-1&client_secret=***",
    ],
  ]);
});

test("http-log: a 2xx answer is info and a rejected answer is an error", () => {
  const httpLog = createHttpLog("ai/http");
  const url = "https://api.openai.com/v1/chat/completions";
  const info = capture("info");
  const error = capture("error");
  try {
    httpLog.response("POST", url, 200);
    httpLog.response("POST", url, 400);
  } finally {
    info.restore();
    error.restore();
  }

  expect(info.calls).toEqual([[`[ai/http] response 200 POST ${url}`]]);
  expect(error.calls).toEqual([[`[ai/http] response 400 POST ${url}`]]);
});

test("http-log: the answer body stays on a debug line", () => {
  const httpLog = createHttpLog("ai/http");
  const url = "https://api.openai.com/v1/chat/completions";
  const debug = capture("debug");
  try {
    httpLog.responseBody("POST", url, 200, { choices: [{ message: { content: "hi" } }] });
    httpLog.responseBody("POST", url, 400, { error: { message: "bad model" } });
  } finally {
    debug.restore();
  }

  expect(debug.calls).toEqual([
    [`[ai/http] response body 200 POST ${url} body={"choices":[{"message":{"content":"hi"}}]}`],
    [`[ai/http] response body 400 POST ${url} body={"error":{"message":"bad model"}}`],
  ]);
});

test("http-log: the failure line keeps the provider category", () => {
  const httpLog = createHttpLog("ai/http");
  const url = "https://api.openai.com/v1/chat/completions";
  const error = capture("error");
  const failure = Object.assign(new Error("rejected"), {
    name: "ProviderProtocolError",
    kind: "invalid_request",
    status: 400,
  });
  try {
    httpLog.failure("POST", url, failure);
  } finally {
    error.restore();
  }

  expect(error.calls).toEqual([
    [
      `[ai/http] failure POST ${url}` +
        " error=ProviderProtocolError: rejected kind=invalid_request status=400",
    ],
  ]);
});

test("http-log: a cancelled request and a stopped call are debug, never errors", () => {
  const httpLog = createHttpLog("ai/http");
  const url = "https://api.openai.com/v1/chat/completions";
  const error = capture("error");
  const debug = capture("debug");
  const cancelled = Object.assign(new Error("stopped"), {
    name: "ProviderProtocolError",
    kind: "cancelled",
  });
  try {
    httpLog.failure("POST", url, cancelled);
    httpLog.aborted("POST", url);
  } finally {
    error.restore();
    debug.restore();
  }

  expect(error.calls).toEqual([]);
  expect(debug.calls).toEqual([
    [`[ai/http] failure POST ${url} error=ProviderProtocolError: stopped kind=cancelled`],
    [`[ai/http] aborted POST ${url}`],
  ]);
});

test("http-log: a long payload keeps its head and states the dropped size", () => {
  const httpLog = createHttpLog("ai/http");
  const url = "https://api.example.com/v1";
  const info = capture("info");
  const debug = capture("debug");
  try {
    httpLog.request("POST", url, "x".repeat(HTTP_LOG_PAYLOAD_LIMIT + 10));
  } finally {
    info.restore();
    debug.restore();
  }

  expect(info.calls).toEqual([[`[ai/http] request POST ${url}`]]);
  expect(debug.calls).toEqual([
    [`[ai/http] request body POST ${url} body=${"x".repeat(HTTP_LOG_PAYLOAD_LIMIT)}…(+10 chars)`],
  ]);
});
