// ABOUTME: OpenAI Responses API provider plugin.
// ABOUTME: Owns /responses payload shape and typed stream lifecycle parsing.
import type { AuthSchemeV1, CredentialKind } from "../../../storage/types";
import { logger } from "../../../logger";
import { DEFAULT_DETECT_MAX_TOKENS } from "../errors";
import type {
  ChatBuildInput,
  DetectPolicy,
  DetectPolicyInput,
  ModelListBuildInput,
  ProviderHttpResponse,
  ProviderPlugin,
  ProviderPluginManifest,
  ProviderWireRequest,
  SseEvent,
  StreamParseResult,
} from "../types";
import { ProviderProtocolError } from "../types";
import { parseOpenAiPage } from "./openaiShared";

/** Keep each chunk under logger MAX_LENGTH (2000) after prefix metadata. */
const STREAM_EVENT_LOG_CHUNK_SIZE = 1_500;
const STREAM_EVENT_LOG_HEAD_SIZE = 200;
const STREAM_EVENT_LOG_TAIL_SIZE = 200;

const STREAM_ERROR_FALLBACK_MESSAGE = "Provider stream error";
const STREAM_FAILED_FALLBACK_MESSAGE = "Provider response failed";

/** True when the SSE event name marks a content delta (must be valid JSON). */
function isDeltaStreamEventName(eventName: string | null): boolean {
  return typeof eventName === "string" && eventName.includes("delta");
}

/** True for terminal failure event names that must surface to the UI. */
function isFailureStreamEventName(eventName: string | null): boolean {
  return eventName === "error" || eventName === "response.failed";
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Extract message from a Responses `error` stream event. */
function extractStreamErrorMessage(value: object): string {
  const topLevel = nonEmptyString((value as { message?: unknown }).message);
  if (topLevel) {
    return topLevel;
  }
  const nested = (value as { error?: unknown }).error;
  if (nested && typeof nested === "object") {
    const nestedMessage = nonEmptyString((nested as { message?: unknown }).message);
    if (nestedMessage) {
      return nestedMessage;
    }
    const nestedCode = nonEmptyString((nested as { code?: unknown }).code);
    if (nestedCode) {
      return nestedCode;
    }
  }
  const code = nonEmptyString((value as { code?: unknown }).code);
  if (code) {
    return code;
  }
  return STREAM_ERROR_FALLBACK_MESSAGE;
}

/** Extract message from a Responses `response.failed` stream event. */
function extractFailedResponseMessage(value: object): string {
  const response = (value as { response?: unknown }).response;
  if (response && typeof response === "object") {
    const error = (response as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = nonEmptyString((error as { message?: unknown }).message);
      if (message) {
        return message;
      }
      const code = nonEmptyString((error as { code?: unknown }).code);
      if (code) {
        return code;
      }
    }
  }
  return STREAM_FAILED_FALLBACK_MESSAGE;
}

function logNonJsonStreamEvent(event: SseEvent, parseError: unknown): void {
  const eventName = event.event ?? "null";
  const data = event.data;
  const dataLen = data.length;
  const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
  const dataHead = dataLen > 0 ? data.slice(0, STREAM_EVENT_LOG_HEAD_SIZE) : "";
  const dataTail = dataLen > 0 ? data.slice(Math.max(0, dataLen - STREAM_EVENT_LOG_TAIL_SIZE)) : "";

  logger.error(
    `openai_responses_stream_event_not_json event=${eventName} dataLen=${dataLen} parseError=${parseMessage} dataHead=${dataHead} dataTail=${dataTail}`,
  );

  const chunkCount = Math.max(1, Math.ceil(dataLen / STREAM_EVENT_LOG_CHUNK_SIZE));
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * STREAM_EVENT_LOG_CHUNK_SIZE;
    const chunk = data.slice(start, start + STREAM_EVENT_LOG_CHUNK_SIZE);
    logger.error(
      `openai_responses_stream_event_not_json_chunk event=${eventName} chunk=${index + 1}/${chunkCount} data=${chunk}`,
    );
  }
}

const MANIFEST: ProviderPluginManifest = {
  id: "openai-responses",
  label: "OpenAI Responses",
  defaultBaseUrl: "https://api.openai.com/v1",
  supportedCredentialKinds: ["none", "api_key", "bearer"],
  capabilities: {
    modelListing: true,
    streaming: true,
    textGeneration: true,
    imageInput: true,
  },
};

function responsesUserInput(userPrompt: string, imagePngBase64: string | null): unknown {
  if (imagePngBase64) {
    return [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${imagePngBase64}`,
          },
        ],
      },
    ];
  }
  return userPrompt;
}

export const openaiResponsesPlugin: ProviderPlugin = {
  manifest: MANIFEST,

  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1 {
    if (credentialKind === "none") {
      return { schemaVersion: 1, type: "none" };
    }
    return { schemaVersion: 1, type: "bearer" };
  },

  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest {
    void input;
    return {
      method: "GET",
      relativePath: "models",
      query: [],
      headers: {},
      body: null,
    };
  },

  parseModelListPage(response: ProviderHttpResponse) {
    return parseOpenAiPage(response);
  },

  buildChatRequest(input: ChatBuildInput): ProviderWireRequest {
    const payload: Record<string, unknown> = {
      model: input.modelKey,
      instructions: input.systemPrompt,
      input: responsesUserInput(input.userPrompt, input.imagePngBase64),
      stream: input.stream,
    };
    if (input.temperature != null) {
      payload.temperature = input.temperature;
    }
    if (input.maxTokens != null) {
      payload.max_output_tokens = input.maxTokens;
    }
    return {
      method: "POST",
      relativePath: "responses",
      query: [],
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
  },

  parseChatResponse(response: ProviderHttpResponse): string {
    let value: unknown;
    try {
      value = JSON.parse(response.body) as unknown;
    } catch {
      throw new ProviderProtocolError("responses body is not JSON");
    }
    if (!value || typeof value !== "object") {
      throw new ProviderProtocolError("invalid responses body");
    }
    const outputText = (value as { output_text?: unknown }).output_text;
    if (typeof outputText === "string" && outputText.trim()) {
      return outputText.trim();
    }
    const output = (value as { output?: unknown }).output;
    if (!Array.isArray(output)) {
      throw new ProviderProtocolError("responses missing output");
    }
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const blockType = (block as { type?: unknown }).type;
        if (blockType === "output_text" || blockType === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) {
            parts.push(text);
          }
        }
      }
    }
    const joined = parts.join("").trim();
    if (!joined) {
      throw new ProviderProtocolError("responses content is empty");
    }
    return joined;
  },

  parseStreamEvent(event: SseEvent): StreamParseResult {
    if (!event.data || event.data === "[DONE]") {
      return { kind: "ignore" };
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch (parseError) {
      logNonJsonStreamEvent(event, parseError);
      // Failure events must still surface even when the payload is malformed.
      if (isFailureStreamEventName(event.event)) {
        return { kind: "error", message: STREAM_ERROR_FALLBACK_MESSAGE };
      }
      // Content only comes from *.delta events. Lifecycle payloads such as
      // response.completed can be large and occasionally truncated; never fail the
      // stream after deltas were already delivered.
      if (isDeltaStreamEventName(event.event)) {
        throw new ProviderProtocolError("stream event is not JSON");
      }
      return { kind: "ignore" };
    }
    if (!value || typeof value !== "object") {
      return { kind: "ignore" };
    }
    // Prefer payload `type` (SDK-style), fall back to SSE event name.
    const ty =
      (typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : null) ??
      event.event ??
      "";

    // Lifecycle: emitted once; no content contribution.
    if (ty === "response.created" || ty === "response.in_progress" || ty === "response.completed") {
      return { kind: "ignore" };
    }

    // Terminal failures — surface message to workflow/toast.
    if (ty === "error") {
      return { kind: "error", message: extractStreamErrorMessage(value) };
    }
    if (ty === "response.failed") {
      return { kind: "error", message: extractFailedResponseMessage(value) };
    }

    // Text streaming deltas (multiple).
    if (ty === "response.output_text.delta" || ty.endsWith("output_text.delta")) {
      const delta = (value as { delta?: unknown }).delta;
      if (typeof delta === "string" && delta.length > 0) {
        return { kind: "delta", text: delta };
      }
      return { kind: "ignore" };
    }

    // Compatibility: nested delta.text shapes from some proxies.
    const nested = (value as { delta?: { text?: unknown } }).delta?.text;
    if (typeof nested === "string" && nested.length > 0) {
      return { kind: "delta", text: nested };
    }
    return { kind: "ignore" };
  },

  getDetectPolicy(input: DetectPolicyInput): DetectPolicy {
    void input;
    return { thinking: null, maxTokens: DEFAULT_DETECT_MAX_TOKENS };
  },
};
