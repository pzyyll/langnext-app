import type { ImageAsset, JSX } from "nsh";
import type { ProviderTypeId } from "../contracts/channel";
import type { ProtocolId } from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";

export type ProviderSettingsMode = "draft" | "saved";

/** Credential edit intent kept by the controller, never by a contribution. */
export type ProviderCredentialMode = "keep" | "replace" | "clear";

/**
 * Controlled connection fields a provider Settings component renders. The host
 * owns these values; the contribution reports edits through the callbacks.
 */
export interface ProviderSettingsProps {
  provider: ProviderDefinition;
  mode: ProviderSettingsMode;
  protocolId: ProtocolId;
  baseUrl: string;
  credential: string;
  hasSavedCredential: boolean;
  credentialMode: ProviderCredentialMode;
  urlError: string | null;
  isInsecureHttp: boolean;
  allowInsecureHttp: boolean;
  compact: boolean;
  disabled: boolean;
  onProtocolChange: (protocolId: ProtocolId) => void;
  onBaseUrlChange: (value: string) => void;
  onCredentialChange: (value: string) => void;
  onCredentialModeChange: (mode: ProviderCredentialMode) => void;
  onInsecureHttpChange: (checked: boolean) => void;
}

/** One provider type's configuration view and brand mark. */
export interface ProviderPresentation {
  providerTypeId: ProviderTypeId;
  Settings: (props: ProviderSettingsProps) => JSX.Element;
  icon: ImageAsset;
}
