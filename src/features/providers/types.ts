// ABOUTME: Pure TypeScript contracts for provider plugins, wire requests, and SSE.
// ABOUTME: No React, Effect, Query, or route imports — shared by plugins and workflows.
import type { AuthSchemeV1, CredentialKind } from "../../storage/types";

export type { AuthSchemeV1, CredentialKind };

export type ProviderHttpMethod = "GET" | "POST";

export interface ProviderWireRequest {
  method: ProviderHttpMethod;
  relativePath: string;
  query: readonly [name: string, value: string][];
  headers: Readonly<Record<string, string>>;
  body: string | null;
}

export interface ProviderHttpRequest {
  requestId: string;
  providerInstanceId: string;
  wire: ProviderWireRequest;
}

export interface ProviderHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type ProviderHttpStreamEvent =
  | { event: "started"; data: { status: number; headers: Record<string, string> } }
  | { event: "chunk"; data: { bytes: number[] } }
  | { event: "finished"; data: null };

export interface ProviderPluginCapabilities {
  modelListing: boolean;
  streaming: boolean;
  textGeneration: boolean;
  imageInput: boolean;
}

export interface ProviderPluginManifest {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
  supportedCredentialKinds: readonly CredentialKind[];
  capabilities: ProviderPluginCapabilities;
}

export interface ModelListBuildInput {
  continuation?: string | null;
}

export interface ParsedModelPageItem {
  modelKey: string;
  remoteDisplayName?: string | null;
  remoteMetadataJson?: unknown | null;
}

export interface ParsedModelPage {
  items: ParsedModelPageItem[];
  continuation: string | null;
}

export type ChatOperation = "translate" | "detect" | "ocr";

export interface ChatBuildInput {
  operation: ChatOperation;
  stream: boolean;
  modelKey: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  thinking: boolean | null;
  imagePngBase64: string | null;
}

export interface SseEvent {
  event: string | null;
  data: string;
}

export type StreamParseResult =
  | { kind: "delta"; text: string }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

export interface DetectPolicyInput {
  modelKey: string;
  baseUrl: string;
}

export interface DetectPolicy {
  thinking: boolean | null;
  maxTokens: number;
}

export class ProviderProtocolError extends Error {
  readonly code = "invalid_response" as const;

  constructor(message = "Invalid provider response") {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

export interface ProviderPlugin {
  readonly manifest: ProviderPluginManifest;
  resolveAuthScheme(credentialKind: CredentialKind): AuthSchemeV1;
  buildModelListRequest(input: ModelListBuildInput): ProviderWireRequest;
  parseModelListPage(response: ProviderHttpResponse): ParsedModelPage;
  buildChatRequest(input: ChatBuildInput): ProviderWireRequest;
  parseChatResponse(response: ProviderHttpResponse): string;
  parseStreamEvent(event: SseEvent): StreamParseResult;
  getDetectPolicy(input: DetectPolicyInput): DetectPolicy;
}
