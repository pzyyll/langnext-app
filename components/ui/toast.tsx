import { cleanup, Overlay, signal, Text, View } from "nsh";
import { Toast as BaseToast, ToastManager, ToastStack, type ToastEntry } from "nsh/base";
import { t } from "nsh/i18n";
import { motion } from "../motion";
import { Button } from "./button";
import { Icon } from "./icon";

export type ToastTone = "neutral" | "success" | "destructive" | "warning";

interface ToastPayload {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

const manager = new ToastManager(motion.toastStack);
const entries = signal<ToastEntry[]>([]);
const paused = signal(false);
let nextSeq = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function syncEntries() {
  entries.set(manager.visible(3));
}

function stopTicker() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTicker() {
  if (timer !== null) return;
  timer = setInterval(() => {
    const adv = manager.advance(paused());
    if (adv.changed || adv.removed.length > 0) {
      syncEntries();
    }
    if (manager.isEmpty()) {
      stopTicker();
    }
  }, 80);
}

function pushToast(tone: ToastTone, title: string, description?: string, timeoutMs = 3500): string {
  nextSeq += 1;
  const id = `toast-${nextSeq}`;
  const payload: ToastPayload = { id, title, description, tone };
  manager.push(id, payload, { timeout: timeoutMs });
  syncEntries();
  ensureTicker();
  return id;
}

/** App-wide non-intrusive toast notifications. */
export const toast = {
  info(title: string, description?: string) {
    return pushToast("neutral", title, description);
  },
  success(title: string, description?: string) {
    return pushToast("success", title, description);
  },
  warning(title: string, description?: string) {
    return pushToast("warning", title, description, 4500);
  },
  error(title: string, description?: string) {
    return pushToast("destructive", title, description, 5000);
  },
  dismiss(id: string) {
    if (manager.dismiss(id)) {
      syncEntries();
      ensureTicker();
    }
  },
};

function ToastIcon(props: { tone: ToastTone }) {
  return (
    <If when={props.tone === "success"}>
      <Icon name="check-circle" tone="success" class="mt-0.5 size-4 shrink-0" />
    </If>
  );
}

/** Mounts inside the app root so any screen can trigger transient toasts. */
export function ToastViewport() {
  cleanup(() => {
    stopTicker();
    manager.dismissAll();
    entries.set([]);
  });

  return (
    <If when={entries().length > 0}>
      <Overlay class="inset-x-0 bottom-4 items-center pointer-events-none">
        <ToastStack
          testID="toast-stack"
          placement="bottomCenter"
          motion={motion.toastStack}
          class="w-80 max-w-full pointer-events-none"
          onExpandedChange={({ expanded }) => paused.set(expanded)}
          onCancel={() => {
            manager.dismissAll();
            syncEntries();
          }}
        >
          <Each of={entries()} key={(entry) => entry.id}>
            {(entry) => {
              const payload = () => entry().value as ToastPayload;
              return (
                <BaseToast
                  testID={`toast-${payload().tone}`}
                  transitionStatus={entry().status}
                  accessibilityLabel={payload().title}
                  class={`flex-row items-start gap-2.5 rounded-xl border border-border bg-popover p-3.5 shadow-lg pointer-events-none ${motion.toastTransition}`}
                  startingClass={motion.toastHidden}
                  endingClass={motion.toastHidden}
                  onDismissRequest={() => toast.dismiss(entry().id)}
                >
                  <ToastIcon tone={payload().tone} />
                  <If when={payload().tone === "destructive" || payload().tone === "warning"}>
                    <Icon
                      name="alert-circle"
                      tone={payload().tone === "destructive" ? "destructive" : "warning"}
                      class="mt-0.5 size-4 shrink-0"
                    />
                  </If>
                  <View class="min-w-0 flex-1 gap-0.5">
                    <Text class="text-sm font-medium text-popover-foreground">
                      {payload().title}
                    </Text>
                    <If when={payload().description !== undefined}>
                      <Text class="text-xs text-muted-foreground">{payload().description}</Text>
                    </If>
                  </View>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    accessibilityLabel={t("common.dismiss")}
                    onPress={() => toast.dismiss(entry().id)}
                    class="shrink-0 pointer-events-auto"
                  >
                    <Icon name="close" tone="muted-foreground" class="size-3.5" />
                  </Button>
                </BaseToast>
              );
            }}
          </Each>
        </ToastStack>
      </Overlay>
    </If>
  );
}
