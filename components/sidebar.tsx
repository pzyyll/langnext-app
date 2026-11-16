import { Image, Text, token, View, type ImageAsset, type JSX } from "nsh";
import { Button, Tooltip } from "nsh/base";
import cubeOutlineIcon from "../assets/icons/cube-outline.svg";
import cubeSolidIcon from "../assets/icons/cube-solid.svg";
import settingsOutlineIcon from "../assets/icons/setting-outline.svg";
import settingsSolidIcon from "../assets/icons/setting-solid.svg";
import { motion } from "./motion";

/** The destinations shown in the sidebar. */
export type SidebarPage = "models" | "settings";

interface SidebarProps {
  page: SidebarPage;
  onSelectModels: () => void;
  onSelectSettings: () => void;
}

interface NavIconProps {
  outline: ImageAsset;
  solid: ImageAsset;
  selected: boolean;
}

/** Draws the outline asset normally and the solid one for the current
 * destination. Both are one-color drawings, so the tint carries the state. */
function NavIcon(props: NavIconProps) {
  return (
    <Image
      src={props.selected ? props.solid : props.outline}
      class="size-5"
      style={{
        tintColor: token(props.selected ? "sidebar-accent-foreground" : "sidebar-foreground"),
      }}
    />
  );
}

interface SidebarItemProps {
  destination: SidebarPage;
  label: string;
  selected: boolean;
  onPress: () => void;
  children?: JSX.Element;
}

function SidebarItem(props: SidebarItemProps) {
  // One token pair carries every state: a sidebar-accent wash, lighter on hover,
  // full while pressed, and held for the current destination. The states belong
  // to the button, so `selected` restyles it without rebuilding the item.
  return (
    <Button
      testID={`nav-${props.destination}`}
      accessibilityLabel={props.label}
      selected={props.selected}
      onPress={() => props.onPress()}
      class={`group size-9 items-center justify-center rounded-sidebar focus-visible:ring-2 focus-visible:ring-sidebar-ring ${motion.navigationFeedback} hover:bg-sidebar-accent/70 active:bg-sidebar-border selected:bg-sidebar-accent selected:hover:bg-sidebar-accent`}
      tooltip={
        <Tooltip
          testID={`${props.destination}-tooltip`}
          placement="right"
          class={`flex-row h-8 items-center rounded-xl border border-border bg-sidebar-primary px-3 py-2 ${motion.tooltip}`}
          startingClass="opacity-0"
          endingClass="opacity-0"
        >
          <Text class="text-xs text-sidebar-primary-foreground">{props.label}</Text>
        </Tooltip>
      }
    >
      {props.children}
    </Button>
  );
}

export function Sidebar(props: SidebarProps) {
  return (
    <View
      testID="sidebar"
      role="navigation"
      accessibilityLabel="Main navigation"
      class="w-13 items-center bg-sidebar py-3"
    >
      <View class="items-center gap-1">
        <SidebarItem
          destination="models"
          label="Models"
          selected={props.page === "models"}
          onPress={() => props.onSelectModels()}
        >
          <NavIcon
            outline={cubeOutlineIcon}
            solid={cubeSolidIcon}
            selected={props.page === "models"}
          />
        </SidebarItem>
      </View>
      <View class="flex-1" />
      <SidebarItem
        destination="settings"
        label="Settings"
        selected={props.page === "settings"}
        onPress={() => props.onSelectSettings()}
      >
        <NavIcon
          outline={settingsOutlineIcon}
          solid={settingsSolidIcon}
          selected={props.page === "settings"}
        />
      </SidebarItem>
    </View>
  );
}
