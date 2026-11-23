import { Text, View, type Align, type JSX, type Placement } from "nsh";
import {
  Menu as BaseMenu,
  MenuItem as BaseMenuItem,
  MenuSeparator as BaseMenuSeparator,
  Submenu as BaseSubmenu,
  type AccessibilityRole,
} from "nsh/base";
import { motion } from "../motion";
import { Icon } from "./icon";

interface MenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  placement?: Placement;
  align?: Align;
  offset?: number;
  popupClass?: string;
  trigger: JSX.Element;
  children?: JSX.Element;
}

/** Popup menu sharing the app's popover surface, shadow, and reveal motion. */
export function Menu(props: MenuProps) {
  return (
    <BaseMenu
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange?.(open)}
      onClose={() => props.onClose?.()}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={props.offset ?? 4}
      popupClass={`${props.popupClass ?? "w-48 max-h-44"} rounded-xl border border-border bg-popover p-1 shadow-lg ${motion.popup}`}
      popupStartingClass={motion.popupHidden}
      popupEndingClass={motion.popupHidden}
      trigger={props.trigger}
    >
      {props.children}
    </BaseMenu>
  );
}

interface SubmenuProps {
  testID?: string;
  open?: boolean;
  disabled?: boolean;
  offset?: number;
  label: string;
  accessibilityLabel?: string;
  onOpenChange?: (open: boolean) => void;
  children?: JSX.Element;
}

/** Cascading submenu item sharing MenuItem row geometry and trailing disclosure chevron. */
export function Submenu(props: SubmenuProps) {
  return (
    <BaseSubmenu
      open={props.open}
      disabled={props.disabled}
      offset={props.offset ?? 4}
      onOpenChange={({ open }) => props.onOpenChange?.(open)}
      class="w-full"
      trigger={
        <View
          testID={props.testID}
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          class={`h-8 w-full flex-row items-center justify-between gap-2 rounded-lg px-2.5 hover:bg-accent focus:bg-accent aria-expanded:bg-accent active:bg-border disabled:opacity-50 ${motion.navigationFeedback}`}
        >
          <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{props.label}</Text>
          <Icon name="mdi:chevron-right" tone="muted-foreground" class="size-3.5 shrink-0" />
        </View>
      }
    >
      {props.children}
    </BaseSubmenu>
  );
}

interface MenuItemProps {
  testID?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: AccessibilityRole;
  closeOnSelect?: boolean;
  accessibilityLabel?: string;
  label?: string;
  class?: string;
  onSelect?: () => void;
  children?: JSX.Element;
}

/** Menu action or checkable option item with consistent height, padding, and state washes. */
export function MenuItem(props: MenuItemProps) {
  const isCheckable = () => props.checked !== undefined;

  return (
    <BaseMenuItem
      testID={props.testID}
      disabled={props.disabled}
      checked={props.checked}
      role={props.role}
      closeOnSelect={props.closeOnSelect}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onSelect={() => props.onSelect?.()}
      class={`group h-8 flex-row items-center gap-2 rounded-lg px-2.5 hover:bg-accent focus:bg-accent active:bg-border checked:bg-accent/60 disabled:opacity-50 ${motion.navigationFeedback} ${props.class ?? ""}`}
      indicatorClass={isCheckable() ? "size-3.5 shrink-0 items-center justify-center" : undefined}
      indicator={
        isCheckable() ? (
          <Icon
            name="mdi:check"
            tone="foreground"
            class="size-3.5 opacity-0 group-checked:opacity-100"
          />
        ) : undefined
      }
    >
      <If when={props.label !== undefined}>
        <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground group-checked:font-medium">
          {props.label}
        </Text>
      </If>
      {props.children}
    </BaseMenuItem>
  );
}

/** Hairline divider grouping menu items. */
export function MenuSeparator(props: { class?: string }) {
  return <BaseMenuSeparator class={`my-1 h-px bg-border ${props.class ?? ""}`} />;
}
