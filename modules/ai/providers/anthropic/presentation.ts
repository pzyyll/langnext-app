import anthropicIcon from "../../../../assets/icons/anthropic.svg";
import { ConnectionFields } from "../../ui/connection-fields";
import type { ProviderPresentation } from "../../ui/contracts";

/** Anthropic configuration view and mark. */
export const anthropicPresentation: ProviderPresentation = {
  providerTypeId: "anthropic",
  Settings: ConnectionFields,
  icon: anthropicIcon,
};
