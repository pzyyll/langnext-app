import { platform, Text, View } from "nsh";
import { Application, Window } from "nsh/desktop";
import { t } from "nsh/i18n";
import { Button } from "../components/ui/button";
import { logFile } from "../services/log";

const DESKTOP_OS: ReadonlySet<string> = new Set(["macos", "windows", "linux"]);

/** The text a start that failed before the shell mounted shows. */
export function startupFailureMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/**
 * The window a start that failed before `AppShell` mounted shows. Window
 * model v2 creates no window until the app declares one, so without it a
 * failed start would leave nothing on the screen.
 */
export function StartupError(props: { message: string }) {
  const desktop = DESKTOP_OS.has(platform.os);
  const exit = () => {
    if (desktop) Application.quit();
  };
  return (
    <Window
      id="startup-error"
      // The system title bar keeps the window movable without the shell's drag row.
      titleBar={{ style: "default" }}
      closeOnPress={false}
      onClosePress={exit}
    >
      <View
        testID="startup-error"
        class="flex-1 items-center justify-center gap-4 bg-background p-8"
      >
        <Text role="header" class="text-center text-lg font-semibold text-foreground">
          {t("startup.failed.title")}
        </Text>
        <View selectable class="max-w-2xl">
          <Text class="text-center text-sm text-muted-foreground">{props.message}</Text>
        </View>
        <If when={logFile() !== null}>
          <Text class="text-center text-xs text-muted-foreground">
            {t("startup.failed.log", { path: logFile() ?? "" })}
          </Text>
        </If>
        <If when={desktop}>
          <Button variant="outline" label={t("startup.failed.exit")} onPress={exit} />
        </If>
      </View>
    </Window>
  );
}
