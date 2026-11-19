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
  | { kind: "model"; modelId: string };

/** Non-streaming text-generation request executed by a registered protocol. */
export interface TextGenerationRequest {
  modelId: string;
  system: string;
  user: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
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
}

/** Per-call protocol context: transport plus cancellation and timeout policy. */
export interface ProtocolContext {
  http: JsonHttpClient;
  signal?: AbortSignal;
  timeoutMs?: number;
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
}
