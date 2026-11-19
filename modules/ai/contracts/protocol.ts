import type { RemoteModelRecord } from "./model";

/** An open wire-protocol identifier, validated when a module registers and when used. */
export type ProtocolId = string;

/** A resolved request root plus a transient credential for this request only. */
export interface ProtocolConnection {
  baseUrl: string;
  credential: string | null;
}

/** Catalog discovery or model endpoint target request. */
export type RequestOperation =
  | { kind: "catalog"; queryExtras?: Record<string, string> }
  | { kind: "model"; modelId: string; stream?: boolean };

/** Text-generation request executed by a registered protocol, streamed or buffered. */
export interface TextGenerationRequest {
  modelId: string;
  system: string;
  user: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  /** Asks the model to skip reasoning or thinking where the protocol can turn it off. */
  disableReasoning?: boolean;
}

/** Resolved HTTP method, URL, and headers for one protocol operation. */
export interface ResolvedRequestTarget {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
}

export interface JsonHttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  redirect?: "follow" | "manual" | "error";
}

/** Event-stream call options; `timeoutMs` bounds inactivity between events, not the whole run. */
export interface JsonEventStreamOptions extends JsonHttpOptions {
  /**
   * Receives one `data:` payload from a server-sent event stream. When the response is a
   * single buffered body instead of an event stream, it receives that body once.
   */
  onEvent: (data: string) => void;
}

/** External JSON HTTP boundary that protocol modules call. */
export interface JsonHttpClient {
  getJson(
    target: ResolvedRequestTarget,
    options?: JsonHttpOptions,
  ): Promise<Record<string, unknown>>;
  postJson(
    target: ResolvedRequestTarget,
    body: Record<string, unknown>,
    options?: JsonHttpOptions,
  ): Promise<Record<string, unknown>>;
  /** Posts a body and reads the response as server-sent events, letting the caller consume as it arrives. */
  postEventStream(
    target: ResolvedRequestTarget,
    body: Record<string, unknown>,
    options: JsonEventStreamOptions,
  ): Promise<void>;
}

/** Per-call protocol context: transport plus cancellation and timeout policy. */
export interface ProtocolContext {
  http: JsonHttpClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Streaming protocol context: the transport plus a sink that receives the text generated so far. */
export interface StreamContext extends ProtocolContext {
  /** Receives the complete generated text after each delta, so a consumer can replace its own copy. */
  onText: (text: string) => void;
}

/** A registered wire API. It never receives provider identity, feature state, or UI. */
export interface ProtocolDefinition {
  id: ProtocolId;
  labelKey: string;
  resolveTarget(connection: ProtocolConnection, operation: RequestOperation): ResolvedRequestTarget;
  listModels(
    connection: ProtocolConnection,
    context: ProtocolContext,
  ): Promise<RemoteModelRecord[]>;
  generateText?(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: ProtocolContext,
  ): Promise<string>;
  /**
   * Sends the same request as a stream, reports text through `context.onText` as it arrives,
   * and resolves with the complete text. Rejects with `invalid_response` when no text arrives.
   */
  streamText?(
    connection: ProtocolConnection,
    request: TextGenerationRequest,
    context: StreamContext,
  ): Promise<string>;
}
