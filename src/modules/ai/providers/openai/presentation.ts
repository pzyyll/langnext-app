import openaiIcon from "../../../../../assets/icons/openai.svg";
import { ConnectionFields } from "../../ui/connection-fields";
import type { ProviderPresentation } from "../../ui/contracts";

/** OpenAI configuration view and mark. */
export const openaiPresentation: ProviderPresentation = {
  providerTypeId: "openai",
  Settings: ConnectionFields,
  icon: openaiIcon,
};
