import geminiIcon from "../../../../assets/icons/gemini.svg";
import { ConnectionFields } from "../../ui/connection-fields";
import type { ProviderPresentation } from "../../ui/contracts";

/** Gemini configuration view and mark. */
export const geminiPresentation: ProviderPresentation = {
  providerTypeId: "gemini",
  Settings: ConnectionFields,
  icon: geminiIcon,
};
