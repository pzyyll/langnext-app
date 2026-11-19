import { appInfo, Image, signal, Text, token, View } from "nsh";
import { Button, Dialog } from "nsh/base";
import { t } from "nsh/i18n";
import appIcon from "../assets/logos/icon.svg";
import { motion } from "./motion";
import { Menu, MenuItem } from "./ui/menu";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function AboutDialog(props: AboutDialogProps) {
  const info = appInfo();

  return (
    <Dialog
      testID="about-dialog"
      accessibilityLabel={t("app.about.label")}
      open={props.open}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      animation={motion.aboutDialog}
      closeOnEscape
      closeOnBackdropPress
      backdropClass="bg-overlay"
      class="m-auto w-96 max-w-full overflow-hidden rounded-2xl border border-border bg-background"
    >
      <View class="border-b border-border px-5 py-3">
        <Text class="text-sm font-medium text-foreground">{t("app.about.title")}</Text>
      </View>
      <View class="items-center gap-5 p-8">
        <Image
          src={appIcon}
          class="size-20"
          accessibilityLabel={t("app.about.logo")}
          // Runtime theme tint keeps the monochrome logo visible in both appearances.
          style={{ tintColor: token("foreground") }}
        />
        <Text class="text-xl font-semibold text-foreground">{info.name}</Text>
        <If when={info.version !== null}>
          <Text class="text-sm text-muted-foreground">
            {t("app.about.version", { version: info.version })}
          </Text>
        </If>
      </View>
      <View class="flex-row justify-end border-t border-border bg-muted px-5 py-3">
        <Button
          accessibilityLabel={t("common.ok")}
          onPress={() => props.onOpenChange(false)}
          class={`h-8 min-w-20 items-center justify-center rounded-lg border border-input bg-background px-4 hover:bg-accent active:bg-border focus-visible:ring-2 focus-visible:ring-ring ${motion.navigationFeedback}`}
        >
          <Text class="text-sm text-foreground">{t("common.ok")}</Text>
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
        onOpenChange={(open) => menuOpen.set(open)}
        onClose={() => {
          if (aboutPending) {
            aboutPending = false;
            aboutOpen.set(true);
          }
        }}
        placement="bottom"
        align="start"
        popupClass="min-w-40"
        trigger={
          <Button
            testID="app-menu-trigger"
            accessibilityLabel={t("app.menu.label")}
            selected={menuOpen()}
            class={`size-8 items-center justify-center rounded-lg hover:bg-sidebar-accent-foreground/10 active:bg-sidebar-accent-foreground/20 selected:bg-sidebar-accent-foreground/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring ${motion.navigationFeedback}`}
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
          accessibilityLabel={t("app.menu.about")}
          label={t("app.menu.about")}
          onSelect={() => {
            aboutPending = true;
          }}
        />
      </Menu>
      <AboutDialog open={aboutOpen()} onOpenChange={(open) => aboutOpen.set(open)} />
    </View>
  );
}
