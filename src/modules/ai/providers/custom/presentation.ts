import cubeIcon from "../../../../../assets/icons/cube-outline.svg";
import { ConnectionFields } from "../../ui/connection-fields";
import type { ProviderPresentation } from "../../ui/contracts";

/** Custom configuration view and neutral mark. */
export const customPresentation: ProviderPresentation = {
  providerTypeId: "custom",
  Settings: ConnectionFields,
  icon: cubeIcon,
};
