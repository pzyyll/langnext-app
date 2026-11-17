/** Built-in provider wire protocol identifiers. */
export type AdapterId =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "deepseek";

/** Authentication scheme applied when calling a provider endpoint. */
export type CredentialKind = "api_key" | "bearer" | "none";

/** Descriptor for a supported provider protocol adapter. */
export interface AdapterSpec {
  id: AdapterId;
  label: string;
  defaultBaseUrl: string;
  defaultCredentialKind: CredentialKind;
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
  adapterId: AdapterId;
  baseUrl: string | null;
  credentialKind: CredentialKind;
  credential: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}
