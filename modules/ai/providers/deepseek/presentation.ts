import deepseekIcon from "../../../../assets/icons/deepseek.svg";
import { ConnectionFields } from "../../ui/connection-fields";
import type { ProviderPresentation } from "../../ui/contracts";

/** DeepSeek configuration view and mark. */
export const deepseekPresentation: ProviderPresentation = {
  providerTypeId: "deepseek",
  Settings: ConnectionFields,
  icon: deepseekIcon,
};
