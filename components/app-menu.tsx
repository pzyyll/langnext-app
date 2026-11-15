import { appInfo, Image, signal, Text, token, View } from "nsh";
import { Button, Dialog, Menu, MenuItem } from "nsh/base";
import appIcon from "../assets/logos/icon128.svg";
import { motion } from "./motion";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function AboutDialog(props: AboutDialogProps) {
  const info = appInfo();

  return (
    <Dialog
      testID="about-dialog"
      accessibilityLabel="About My Translator"
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      animation={motion.aboutDialog}
      closeOnEscape
      closeOnBackdropPress
      backdropClass="bg-overlay"
      class="m-auto w-96 max-w-full overflow-hidden rounded-2xl border border-border bg-background"
    >
      <View class="border-b border-border px-5 py-3">
        <Text class="text-sm font-medium text-foreground">About My Translator</Text>
      </View>
      <View class="items-center gap-5 p-8">
        <Image
          src={appIcon}
          class="size-20"
          accessibilityLabel="My Translator logo"
          // Runtime theme tint keeps the monochrome logo visible in both appearances.
          style={{ tintColor: token("foreground") }}
        />
        <Text class="text-xl font-semibold text-foreground">{info.name}</Text>
        <If when={info.version !== null}>
          <Text class="text-sm text-muted-foreground">Version {info.version}</Text>
        </If>
      </View>
      <View class="flex-row justify-end border-t border-border bg-muted px-5 py-3">
        <Button
          accessibilityLabel="OK"
          onPress={() => props.onOpenChange(false)}
          class={`h-8 min-w-20 items-center justify-center rounded-lg border border-input bg-background px-4 hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
        >
          <Text class="text-sm text-foreground">OK</Text>
        </Button>
      </View>
    </Dialog>
  );
}

/** The title-bar menu owns its overlays for the lifetime of the shell. */
export function AppMenu() {
  const menuOpen = signal(false);
  const aboutOpen = signal(false);
  let aboutPending = false;

  return (
    <View desktop={{ windowDrag: false }}>
      <Menu
        open={menuOpen()}
        onOpenChange={({ open }) => menuOpen.set(open)}
        onClose={() => {
          if (aboutPending) {
            aboutPending = false;
            aboutOpen.set(true);
          }
        }}
        placement="bottom"
        align="start"
        popupClass={`min-w-40 rounded-xl border border-border bg-popover p-1 shadow-lg ${motion.popup}`}
        popupStartingClass={motion.popupHidden}
        popupEndingClass={motion.popupHidden}
        trigger={
          <Button
            testID="app-menu-trigger"
            accessibilityLabel="App menu"
            selected={menuOpen()}
            class={`size-8 items-center justify-center rounded-lg hover:bg-sidebar-accent/70 active:bg-sidebar-border selected:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring ${motion.navigationFeedback}`}
          >
            <Image
              src={appIcon}
              class="size-5"
              accessibilityElementsHidden
              // Runtime theme tint keeps the title-bar logo visible in dark mode.
              style={{ tintColor: token("sidebar-foreground") }}
            />
          </Button>
        }
      >
        <MenuItem
          accessibilityLabel="About"
          onSelect={() => {
            aboutPending = true;
          }}
          class={`h-8 justify-center rounded-lg px-3 hover:bg-accent focus:bg-accent active:bg-border ${motion.navigationFeedback}`}
        >
          <Text class="text-sm text-popover-foreground">About</Text>
        </MenuItem>
      </Menu>
      <AboutDialog open={aboutOpen()} onOpenChange={(open) => aboutOpen.set(open)} />
    </View>
  );
}
