import type { ProviderTypeId } from "./channel";
import type { ProtocolId, RequestOperation } from "./protocol";

/** Input for an optional provider root-path policy. It receives no credential. */
export interface ProviderBaseUrlInput {
  baseUrl: string;
  protocolId: ProtocolId;
  operation: RequestOperation;
}

/**
 * Plain policy for one provider type. It owns no component, Store, Storage, or
 * credential access, and its optional root resolver may change the path only.
 */
export interface ProviderDefinition {
  id: ProviderTypeId;
  labelKey: string;
  allowedProtocolIds: readonly ProtocolId[];
  defaultProtocolId: ProtocolId;
  defaultBaseUrl: string | null;
  /** Fixed discovery protocol; omit it to use the selected default protocol. */
  catalogProtocolId?: ProtocolId | null;
  /** models.dev provider ID, or `null` for model-ID-only lookup. */
  catalogProviderId: string | null;
  resolveBaseUrl?: (input: ProviderBaseUrlInput) => string;
}
