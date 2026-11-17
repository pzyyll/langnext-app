import type { ProtocolId } from "./protocol";

/** An open provider-type identifier, validated when a module registers and when used. */
export type ProviderTypeId = string;

/** Credential edit intent for a saved channel. */
export type CredentialUpdate =
  | { mode: "keep" }
  | { mode: "replace"; value: string }
  | { mode: "clear" };

/** Where the request credential comes from for a connection snapshot. */
export type ConnectionCredentialInput =
  | { mode: "inline"; value: string | null }
  | { mode: "saved"; channelId: string; update: CredentialUpdate };

/** Persisted provider channel configuration (never holds raw secret tokens). */
export interface ProviderChannel {
  id: string;
  presetId: ProviderTypeId;
  displayName: string;
  adapterId: ProtocolId;
  baseUrl: string | null;
  hasCredential: boolean;
  enabled: boolean;
  sortOrder: number;
  revision: number;
  insecureHttpConfirmedAt: string | null;
  modelsLastSyncedAt: string | null;
  modelsLastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Immutable connection snapshot captured from the current editor inputs. */
export interface ConnectionSnapshot {
  presetId: ProviderTypeId;
  adapterId: ProtocolId;
  baseUrl: string | null;
  allowInsecureHttp: boolean;
  credentialInput: ConnectionCredentialInput;
}
