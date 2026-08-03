// ABOUTME: Semantic provider executor contract tests for the legacy frontend adapter.
// ABOUTME: Uses fixed OpenAI Compatible fixtures; asserts no wire request reaches callers.
import { afterEach, describe, expect, test } from "bun:test";
import { registerBuiltinProviderPlugins } from "./builtin";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import {
  ExecutorHttpStatusError,
  ExecutorProtocolError,
  LegacyFrontendProviderExecutor,
  type ExecutorChatInput,
  type ExecutorModelsListResult,
  type ExecutorUnaryChatResult,
} from "./executor";
import { normalizeProviderError } from "./errors";
import { ProviderProtocolError } from "./types";

installTauriInvokeMock();
registerBuiltinProviderPlugins();

// Fixed OpenAI Compatible fixture literals (ported from builtin/openaiCompatible.test.ts).
const FIXED_MODELS_BODY = JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] });
const FIXED_CHAT_BODY = JSON.stringify({ choices: [{ message: { content: "  hi  " } }] });
const FIXED_STREAM_DELTA_EVENT = JSON.stringify({ choices: [{ delta: { content: "wo" } }] });

const PROVIDER_ID = "provider-1";
const PLUGIN_ID = "openai-compatible";

const CHAT_INPUT = {
  operation: "translate" as const,
  stream: false,
  modelKey: "gpt-4o-mini",
  systemPrompt: "sys",
  userPrompt: "hello",
  temperature: 0.2,
  maxTokens: 128,
  thinking: null,
  imagePngBase64: null,
} satisfies ExecutorChatInput;

/** Encode SSE events (each `data:` line followed by the required blank line). */
function encodeSseEvents(...dataLines: string[]): number[] {
  return Array.from(new TextEncoder().encode(dataLines.map((line) => `data: ${line}\n\n`).join("")));
}

afterEach(() => {
  resetInvokeMock();
});

describe("LegacyFrontendProviderExecutor", () => {
  test("legacy_frontend_executor_satisfies_models_unary_stream_and_cancel_contract", async () => {
    const wireRelativePaths: string[] = [];
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_request") {
        const wire = (args.input as { wire: { relativePath: string } }).wire;
        wireRelativePaths.push(wire.relativePath);
        if (wire.relativePath === "models") {
          return { status: 200, headers: {}, body: FIXED_MODELS_BODY };
        }
        return { status: 200, headers: {}, body: FIXED_CHAT_BODY };
      }
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents(FIXED_STREAM_DELTA_EVENT) } });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents("[DONE]") } });
        onEvent({ event: "finished", data: null });
        return undefined;
      }
      if (cmd === "cancel_provider_http") {
        return true;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const executor = new LegacyFrontendProviderExecutor(PROVIDER_ID, PLUGIN_ID);

    // Complete Models List produces semantic descriptors only — never a wire request,
    // HTTP status, or headers.
    const list = await executor.modelsList({});
    expect(list).toEqual({
      models: [
        { modelKey: "gpt-4o-mini", remoteDisplayName: null, remoteMetadataJson: null },
        { modelKey: "gpt-4o", remoteDisplayName: null, remoteMetadataJson: null },
      ],
    } satisfies ExecutorModelsListResult);

    // Unary Chat returns the fixed parsed text.
    const chat = await executor.chat({ ...CHAT_INPUT, requestId: "req-u1" });
    expect(chat).toEqual({ text: "hi" } satisfies ExecutorUnaryChatResult);

    // Streaming Chat delivers ordered text deltas and ignores the [DONE] marker.
    const deltas: string[] = [];
    await executor.chatStream(
      { ...CHAT_INPUT, stream: true, requestId: "req-s1" },
      { onDelta: (text) => deltas.push(text) },
    );
    expect(deltas).toEqual(["wo"]);

    // Best-effort cancellation invokes the backend exactly once per request id.
    await executor.cancel("req-s1");
    const cancelCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "cancel_provider_http");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.[1]).toEqual({ requestId: "req-s1" });

    // The caller never supplied a wire request: the adapter built every wire itself.
    expect(wireRelativePaths).toEqual(["models", "chat/completions"]);
  });

  test("best-effort cancellation swallows backend failure", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cancel_provider_http") {
        throw new Error("cancel failed");
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const executor = new LegacyFrontendProviderExecutor(PROVIDER_ID, PLUGIN_ID);
    await expect(executor.cancel("req-x")).resolves.toBeUndefined();
  });

  test("legacy_executor_preserves_openai_compatible_model_and_chat_fixtures", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_request") {
        const wire = (args.input as { wire: { relativePath: string } }).wire;
        if (wire.relativePath === "models") {
          return { status: 200, headers: {}, body: FIXED_MODELS_BODY };
        }
        return { status: 200, headers: {}, body: FIXED_CHAT_BODY };
      }
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        // Split one SSE event across chunk boundaries to exercise the incremental decoder.
        const eventBytes = new TextEncoder().encode(`data: ${FIXED_STREAM_DELTA_EVENT}\n\n`);
        const mid = Math.floor(eventBytes.length / 2);
        onEvent({ event: "chunk", data: { bytes: Array.from(eventBytes.slice(0, mid)) } });
        onEvent({ event: "chunk", data: { bytes: Array.from(eventBytes.slice(mid)) } });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents("[DONE]") } });
        onEvent({ event: "finished", data: null });
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    const executor = new LegacyFrontendProviderExecutor(PROVIDER_ID, PLUGIN_ID);

    const list = await executor.modelsList({});
    expect(list.models.map((item) => item.modelKey)).toEqual(["gpt-4o-mini", "gpt-4o"]);

    const chat = await executor.chat({ ...CHAT_INPUT, requestId: "req-c1" });
    expect(chat.text).toBe("hi");

    const deltas: string[] = [];
    await executor.chatStream(
      { ...CHAT_INPUT, stream: true, requestId: "req-c2" },
      { onDelta: (text) => deltas.push(text) },
    );
    expect(deltas).toEqual(["wo"]);
  });

  test("legacy executor preserves malformed response normalization", async () => {
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "provider_http_request") {
        return { status: 200, headers: {}, body: "not-json" };
      }
      if (cmd === "provider_http_stream") {
        const onEvent = (args.onEvent as { onmessage: (event: unknown) => void }).onmessage;
        onEvent({ event: "started", data: { status: 200, headers: {} } });
        onEvent({ event: "chunk", data: { bytes: encodeSseEvents("not-json") } });
        onEvent({ event: "finished", data: null });
        return undefined;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });
    const executor = new LegacyFrontendProviderExecutor(PROVIDER_ID, PLUGIN_ID);

    // Unary malformed body: the plugin's ProviderProtocolError propagates untouched.
    const chatRejection = await executor.chat({ ...CHAT_INPUT, requestId: "req-c4" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(chatRejection).toBeInstanceOf(ProviderProtocolError);
    expect(normalizeProviderError(chatRejection)).toEqual({
      code: "invalid_response",
      message: "chat response is not JSON",
      retryable: true,
    });

    // Stream malformed event: same normalized result the current workflow observes.
    const streamRejection = await executor
      .chatStream({ ...CHAT_INPUT, stream: true, requestId: "req-c3" }, { onDelta: () => {} })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(normalizeProviderError(streamRejection)).toEqual({
      code: "invalid_response",
      message: "stream event is not JSON",
      retryable: false,
    });
  });

  test("executor errors normalize with current retry semantics", () => {
    expect(normalizeProviderError(new ExecutorHttpStatusError(429))).toEqual({
      code: "rate_limited",
      message: "Provider HTTP 429",
      retryable: true,
    });
    expect(normalizeProviderError(new ExecutorHttpStatusError(401))).toEqual({
      code: "auth",
      message: "Provider HTTP 401",
      retryable: false,
    });
    expect(normalizeProviderError(new ExecutorProtocolError("Empty stream content"))).toEqual({
      code: "invalid_response",
      message: "Empty stream content",
      retryable: true,
    });
  });
});
