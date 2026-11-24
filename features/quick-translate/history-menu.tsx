import type { HistorySnapshot, HistorySummary } from "langnext/native";
import { cleanup, effect, signal, Text, type ViewRef } from "nsh";
import { t } from "nsh/i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Menu, MenuItem } from "../../components/ui/menu";
import { listRecentHistory, readHistory } from "./history";

/** A bounded list of quick actions that restore saved results without a translation request. */
export function QuickTranslateHistoryMenu(props: {
  available: boolean;
  draftRevision: () => number;
  onOpenChange: (open: boolean) => void;
  onRestore: (snapshot: HistorySnapshot) => void;
  onFocusSource: () => void;
}) {
  const open = signal(false);
  const entries = signal<HistorySummary[]>([]);
  const status = signal<"loading" | "ready" | "list-error" | "restore-error">("loading");
  let generation = 0;
  let restoredDraft: number | null = null;
  let trigger: ViewRef | null = null;

  const changeOpen = (next: boolean) => {
    if (open() === next) return;
    if (next) trigger?.focus();
    const current = ++generation;
    open.set(next);
    props.onOpenChange(next);
    if (!next) return;
    restoredDraft = null;
    entries.set([]);
    status.set("loading");
    void listRecentHistory().then(
      (recent) => {
        if (current !== generation) return;
        entries.set(recent);
        status.set("ready");
      },
      () => {
        if (current === generation) status.set("list-error");
      },
    );
  };

  effect(() => {
    if (!props.available) changeOpen(false);
  });
  cleanup(() => {
    generation += 1;
  });

  const select = async (id: string) => {
    const current = ++generation;
    const draft = props.draftRevision();
    const isCurrent = () =>
      current === generation && open() && props.available && draft === props.draftRevision();
    status.set("ready");
    try {
      const snapshot = await readHistory(id);
      if (!isCurrent()) return;
      if (snapshot === null) {
        entries.set(entries().filter((entry) => entry.id !== id));
        status.set("restore-error");
        return;
      }
      props.onRestore(snapshot);
      restoredDraft = props.draftRevision();
      changeOpen(false);
    } catch {
      if (isCurrent()) status.set("restore-error");
    }
  };

  return (
    <Menu
      open={open()}
      onOpenChange={changeOpen}
      onClose={() => {
        if (props.available && restoredDraft === props.draftRevision()) props.onFocusSource();
        restoredDraft = null;
      }}
      align="end"
      popupClass="w-64 max-h-60"
      trigger={
        <Button
          testID="quick-translate-history"
          ref={(node) => {
            trigger = node;
          }}
          variant="ghost"
          size="icon-sm"
          tooltip={t("quickTranslate.history")}
          accessibilityLabel={t("quickTranslate.history")}
          selected={open()}
          disabled={!props.available}
        >
          <Icon name="mdi:history" tone="muted-foreground" class="size-3.5" />
        </Button>
      }
    >
      <If when={status() === "loading" || (status() === "ready" && entries().length === 0)}>
        <Text class="px-3 py-2 text-sm text-muted-foreground">
          {t(
            status() === "loading"
              ? "quickTranslate.historyLoading"
              : "quickTranslate.historyEmpty",
          )}
        </Text>
      </If>
      <If when={status() === "list-error" || status() === "restore-error"}>
        <Text role="alert" class="px-3 py-2 text-sm text-destructive">
          {t(
            status() === "list-error"
              ? "quickTranslate.historyLoadError"
              : "quickTranslate.historyRestoreError",
          )}
        </Text>
      </If>
      <Each of={entries()} key={(entry) => entry.id}>
        {(entry) => (
          <MenuItem
            testID="quick-translate-history-entry"
            label={entry().preview}
            closeOnSelect={false}
            onSelect={() => void select(entry().id)}
          />
        )}
      </Each>
    </Menu>
  );
}
