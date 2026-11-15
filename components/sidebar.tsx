import { Image, keymap, Text, token, View, type JSX } from "nsh";
import { Button, Tooltip } from "nsh/base";
import settingsIcon from "../assets/icons/settings.svg";
import { motion } from "./motion";

/** Keyboard navigation shared by the shell and the sidebar hints. */
export const SIDEBAR_SHORTCUTS = { home: "mod+1", settings: "mod+," };

/** The destinations shown in the sidebar. */
export type SidebarPage = keyof typeof SIDEBAR_SHORTCUTS;

interface SidebarProps {
  page: SidebarPage;
  onSelectHome: () => void;
  onSelectSettings: () => void;
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
      class={`group size-9 items-center justify-center rounded-sidebar focus-visible:ring-2 focus-visible:ring-sidebar-ring ${motion.navigationFeedback} hover:bg-sidebar-accent/70 active:bg-sidebar-accent selected:bg-sidebar-accent selected:hover:bg-sidebar-accent`}
      tooltip={
        <Tooltip
          testID={`${props.destination}-tooltip`}
          placement="right"
          class={`flex-row items-center gap-3 rounded-xl border border-border bg-sidebar-primary px-3 py-2 ${motion.tooltip}`}
          startingClass="opacity-0"
          endingClass="opacity-0"
        >
          <Text class="text-xs text-sidebar-primary-foreground">{props.label}</Text>
          <Text class="text-xs text-sidebar-primary-foreground">
            {keymap.label(SIDEBAR_SHORTCUTS[props.destination])}
          </Text>
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
      class="w-14 items-center border-r border-sidebar-border bg-sidebar py-3"
    >
      <SidebarItem
        destination="home"
        label="Home"
        selected={props.page === "home"}
        onPress={() => props.onSelectHome()}
      >
        <Text class="text-lg font-semibold text-sidebar-foreground group-selected:text-sidebar-accent-foreground">
          M
        </Text>
      </SidebarItem>
      <View class="flex-1" />
      <SidebarItem
        destination="settings"
        label="Settings"
        selected={props.page === "settings"}
        onPress={() => props.onSelectSettings()}
      >
        <Image
          src={settingsIcon}
          class="size-5"
          style={{
            tintColor: token(
              props.page === "settings" ? "sidebar-accent-foreground" : "sidebar-foreground",
            ),
          }}
        />
      </SidebarItem>
    </View>
  );
}
