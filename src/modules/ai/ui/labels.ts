import { t } from "nsh/i18n";
import type { ProviderTypeId } from "../contracts/channel";
import type { ProtocolId } from "../contracts/protocol";
import type { ProviderDefinition } from "../contracts/provider";
import { aiRegistry } from "../runtime/registry";

/** Resolves a translated protocol label, tolerating a reference this build lacks. */
export function getProtocolLabel(protocolId: ProtocolId): string {
  try {
    return t(aiRegistry.getProtocol(protocolId).labelKey);
  } catch {
    return protocolId;
  }
}

/** Resolves the translated provider label from its definition. */
export function getProviderLabel(provider: ProviderDefinition): string {
  return t(provider.labelKey);
}

/** Resolves a provider label for stored records, tolerating an unknown provider. */
export function getProviderTypeLabel(providerTypeId: ProviderTypeId): string | null {
  try {
    return getProviderLabel(aiRegistry.getProvider(providerTypeId));
  } catch {
    return null;
  }
}
