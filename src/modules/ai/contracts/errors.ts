/** Normalized error category for provider network and module operations. */
export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "invalid_request"
  | "invalid_response"
  | "cancelled";

/** Structured error thrown across protocol, registry, and provider boundaries. */
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
