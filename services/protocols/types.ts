import type { ProviderPresetId } from "./presets";

/** Built-in provider wire protocol identifiers. */
export type AdapterId = "openai-compatible" | "openai-responses" | "anthropic" | "gemini";

/** Descriptor for a supported provider protocol adapter. */
export interface AdapterSpec {
  id: AdapterId;
  label: string;
  defaultBaseUrl: string;
}

/** Normalized remote model entry returned by a protocol adapter. */
export interface DiscoveredRemoteModel {
  modelKey: string;
  displayName: string | null;
  contextLimit: number | null;
  maxTokens: number | null;
  capabilities: {
    text: boolean;
    image: boolean;
    pdf: boolean;
    video: boolean;
  };
}

/** Normalized error category for provider network operations. */
export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "invalid_request"
  | "invalid_response"
  | "cancelled";

/** Structured error thrown by protocol adapter calls. */
export class ProviderProtocolError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderProtocolError";
    this.kind = kind;
    this.status = status;
  }
}

export interface AdapterRequestParams {
  presetId: ProviderPresetId;
  adapterId: AdapterId;
  baseUrl: string | null;
  credential: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RequestOperation =
  | { kind: "catalog"; queryExtras?: Record<string, string> }
  | { kind: "model"; modelId: string };

export interface ResolvedRequestTarget {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
}
