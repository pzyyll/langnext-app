import { cleanup, effect, signal, Text, View, windowSize } from "nsh";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { SectionHeading } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Icon, type IconName } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Select, type SelectItem } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { toast } from "../../components/ui/toast";
import { buildTooltip } from "../../components/ui/tooltip";
import { ADAPTER_SPECS } from "../../services/protocols/adapters";
import type { AdapterId } from "../../services/protocols/types";
import {
  formatModelApiTypeDisplay,
  formatSyncTimestamp,
  formatTokenCount,
  resolveEffectiveCapabilities,
  resolveEffectiveDisplayName,
} from "./model-helpers";
import {
  deleteModelsBulk,
  setModelEnabled,
  syncChannelModels,
  testChannelConnection,
} from "./store";
import type { CapabilityFlags, ModelsEnabledFilter, ProviderChannel, ProviderModel } from "./types";

const PROTOCOL_ITEMS: SelectItem[] = ADAPTER_SPECS.map((spec) => ({
  value: spec.id,
  title: spec.label,
}));

const FILTER_ITEMS: SelectItem[] = [
  { value: "all", title: "All" },
  { value: "enabled", title: "Enabled" },
  { value: "disabled", title: "Disabled" },
];

const CAPABILITY_ITEMS: ReadonlyArray<{
  key: keyof CapabilityFlags;
  icon: IconName;
  label: string;
}> = [
  { key: "text", icon: "file-text", label: "Text" },
  { key: "image", icon: "pic", label: "Image" },
  { key: "pdf", icon: "file-pdf", label: "PDF" },
  { key: "video", icon: "video", label: "Video" },
];

function CapabilityIcons(props: { capabilities: CapabilityFlags }) {
  return (
    <View class="flex-row items-center gap-1">
      <Each
        of={CAPABILITY_ITEMS.filter((item) => props.capabilities[item.key])}
        key={(item) => item.key}
      >
        {(item) => (
          <View
            accessibilityLabel={item().label}
            tooltip={buildTooltip(item().label, "top")}
            class="size-5 items-center justify-center rounded bg-muted"
          >
            <Icon name={item().icon} tone="foreground" class="size-3" />
          </View>
        )}
      </Each>
    </View>
  );
}

interface ModelsTableProps {
  channel: ProviderChannel;
  models: ProviderModel[];
  enabledFilter: ModelsEnabledFilter;
  isDirty: boolean;
  onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
  onAddModel: () => void;
  onConfigureModel: (model: ProviderModel) => void;
}

/** Models toolbar, remote sync controls, filterable table, and bulk deletion. */
export function ModelsTable(props: ModelsTableProps) {
  const searchQuery = signal("");
  const selectionMode = signal(false);
  const selectedIds = signal<string[]>([]);
  const syncAdapterId = signal<AdapterId>(props.channel.adapterId);
  const testing = signal(false);
  const syncing = signal(false);
  const connectionMessage = signal<{ ok: boolean; text: string } | null>(null);
  const bulkDeleteOpen = signal(false);
  const bulkDeleting = signal(false);

  let activeController: AbortController | null = null;
  let lastChannelId = "";

  const abortInFlight = () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  };

  cleanup(() => abortInFlight());

  effect(() => {
    const channelId = props.channel.id;
    const defaultAdapter = props.channel.adapterId;
    if (channelId !== lastChannelId) {
      lastChannelId = channelId;
      abortInFlight();
      searchQuery.set("");
      selectionMode.set(false);
      selectedIds.set([]);
      syncAdapterId.set(defaultAdapter);
      testing.set(false);
      syncing.set(false);
      connectionMessage.set(null);
      bulkDeleteOpen.set(false);
    }
  });

  const filteredModels = () => {
    const query = searchQuery().trim().toLowerCase();
    const filter = props.enabledFilter;
    return props.models
      .filter((model) => {
        if (filter === "enabled" && !model.enabled) return false;
        if (filter === "disabled" && model.enabled) return false;
        if (!query) return true;
        const name = resolveEffectiveDisplayName(model).toLowerCase();
        const key = model.modelKey.toLowerCase();
        const apiLabel = formatModelApiTypeDisplay(model, props.channel.adapterId).toLowerCase();
        return name.includes(query) || key.includes(query) || apiLabel.includes(query);
      })
      .sort((a, b) => resolveEffectiveDisplayName(a).localeCompare(resolveEffectiveDisplayName(b)));
  };

  const visibleIdSet = () => new Set(filteredModels().map((m) => m.id));
  const selectedVisibleIds = () => selectedIds().filter((id) => visibleIdSet().has(id));
  const allVisibleSelected = () => {
    const visible = filteredModels();
    return visible.length > 0 && selectedVisibleIds().length === visible.length;
  };
  const someVisibleSelected = () => selectedVisibleIds().length > 0;

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      selectedIds.set(filteredModels().map((m) => m.id));
    } else {
      const visible = visibleIdSet();
      selectedIds.set(selectedIds().filter((id) => !visible.has(id)));
    }
  };

  const toggleRowSelection = (modelId: string, checked: boolean) => {
    if (checked) {
      if (!selectedIds().includes(modelId)) {
        selectedIds.set([...selectedIds(), modelId]);
      }
    } else {
      selectedIds.set(selectedIds().filter((id) => id !== modelId));
    }
  };

  const handleTest = async () => {
    if (testing() || syncing() || props.isDirty) return;
    abortInFlight();
    activeController = new AbortController();
    testing.set(true);
    connectionMessage.set(null);
    try {
      const result = await testChannelConnection(
        props.channel.id,
        syncAdapterId(),
        activeController.signal,
      );
      const text = `Connected (${result.modelCount} ${result.modelCount === 1 ? "model" : "models"} reachable)`;
      connectionMessage.set(null);
      toast.success(text);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Connection test failed.";
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        connectionMessage.set({ ok: false, text });
        toast.error(text);
      }
    } finally {
      testing.set(false);
      activeController = null;
    }
  };

  const handleGetModels = async () => {
    if (syncing() || testing() || props.isDirty) return;
    abortInFlight();
    activeController = new AbortController();
    syncing.set(true);
    connectionMessage.set(null);
    try {
      const summary = await syncChannelModels(
        props.channel.id,
        syncAdapterId(),
        activeController.signal,
      );
      toast.success(`Synced ${summary.discoveredCount} models (${summary.addedCount} added)`);
    } catch (error) {
      if ((error as { kind?: string } | null)?.kind !== "cancelled") {
        toast.error(error instanceof Error ? error.message : "Failed to fetch models.");
      }
    } finally {
      syncing.set(false);
      activeController = null;
    }
  };

  const handleToggleEnabled = async (model: ProviderModel, checked: boolean) => {
    try {
      await setModelEnabled(model.id, checked);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update model state.");
    }
  };

  const handleConfirmBulkDelete = async () => {
    const ids = selectedIds();
    if (ids.length === 0 || bulkDeleting()) return;
    bulkDeleting.set(true);
    try {
      const count = await deleteModelsBulk(props.channel.id, ids);
      toast.success(`Deleted ${count} ${count === 1 ? "model" : "models"}`);
      selectedIds.set([]);
      selectionMode.set(false);
      bulkDeleteOpen.set(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete selected models.");
    } finally {
      bulkDeleting.set(false);
    }
  };

  const compactColumns = () => windowSize().width < 860;

  const syncStatusLabel = () => {
    if (props.channel.modelsLastSyncError) {
      return `Sync error: ${props.channel.modelsLastSyncError}`;
    }
    const ts = formatSyncTimestamp(props.channel.modelsLastSyncedAt);
    return ts ? `Synced: ${ts}` : "Never synced";
  };

  return (
    <>
      <View class="gap-4">
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <SectionHeading title="Models" />
          <View class="flex-row flex-wrap items-center gap-2">
            <Select
              testID="sync-protocol-select"
              accessibilityLabel="Sync protocol"
              items={PROTOCOL_ITEMS}
              value={syncAdapterId()}
              onChange={(v) => {
                if (v) syncAdapterId.set(v as AdapterId);
              }}
              triggerClass="h-8"
            />
            <Button
              testID="test-connection-button"
              variant="outline"
              size="sm"
              label={testing() ? "Testing…" : "Test"}
              disabled={testing() || syncing() || props.isDirty}
              onPress={() => void handleTest()}
            />
            <Button
              testID="get-models-button"
              variant="outline"
              size="sm"
              label={syncing() ? "Fetching…" : "Get models"}
              disabled={syncing() || testing() || props.isDirty}
              onPress={() => void handleGetModels()}
            />
          </View>
        </View>

        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <Text
            class={
              props.channel.modelsLastSyncError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {syncStatusLabel()}
          </Text>
          <If when={props.isDirty}>
            <Text class="text-xs text-warning">
              Save connection changes before testing or syncing.
            </Text>
          </If>
          <If when={props.isDirty ? null : connectionMessage()}>
            {(msg) => (
              <Text class={msg().ok ? "text-xs text-success" : "text-xs text-destructive"}>
                {msg().text}
              </Text>
            )}
          </If>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <Input
            testID="models-search-input"
            size="sm"
            leadingIcon="search"
            placeholder="Filter models…"
            accessibilityLabel="Search models"
            clearLabel="Clear model search"
            value={searchQuery()}
            onChange={(v) => searchQuery.set(v)}
            onClear={() => searchQuery.set("")}
            class="min-w-44 flex-1"
          />
          <Select
            testID="models-filter-select"
            accessibilityLabel="Filter models by status"
            items={FILTER_ITEMS}
            value={props.enabledFilter}
            onChange={(v) => {
              if (v) props.onEnabledFilterChange(v as ModelsEnabledFilter);
            }}
            triggerClass="h-8 w-28"
          />
          <Button
            testID="add-model-button"
            variant="outline"
            size="sm"
            accessibilityLabel="Add Model"
            onPress={() => props.onAddModel()}
          >
            <Icon name="plus" tone="foreground" class="size-3.5" />
            <Text class="text-sm font-medium text-foreground">Add Model</Text>
          </Button>
          <If
            when={selectionMode()}
            else={
              <Button
                testID="select-models-button"
                variant="outline"
                size="sm"
                label="Select"
                disabled={props.models.length === 0}
                onPress={() => selectionMode.set(true)}
              />
            }
          >
            <View class="flex-row items-center gap-2">
              <Button
                testID="bulk-delete-models-button"
                variant="destructive"
                size="sm"
                label={`Delete (${selectedIds().length})`}
                disabled={selectedIds().length === 0}
                onPress={() => bulkDeleteOpen.set(true)}
              />
              <Button
                variant="ghost"
                size="sm"
                label="Done"
                onPress={() => {
                  selectionMode.set(false);
                  selectedIds.set([]);
                }}
              />
            </View>
          </If>
        </View>

        <If
          when={filteredModels().length > 0}
          else={
            <View class="items-center justify-center rounded-lg border border-border bg-muted/30 px-4 py-8">
              <Text class="text-sm text-muted-foreground">
                {props.models.length === 0 ? "No models yet" : "No matching models"}
              </Text>
            </View>
          }
        >
          <Table accessibilityLabel="Channel models">
            <TableHeader>
              <TableRow class="py-2">
                <If when={selectionMode()}>
                  <TableHead class="w-7 shrink-0">
                    <Checkbox
                      testID="select-all-models-checkbox"
                      accessibilityLabel="Select all visible models"
                      checked={allVisibleSelected()}
                      indeterminate={someVisibleSelected() && !allVisibleSelected()}
                      onChange={toggleSelectAll}
                    />
                  </TableHead>
                </If>
                <TableHead class="min-w-0 flex-1">
                  <Text class="text-xs font-medium text-muted-foreground">Model</Text>
                </TableHead>
                <If when={!compactColumns()}>
                  <TableHead class="w-28 shrink-0">
                    <Text class="text-xs font-medium text-muted-foreground">API Type</Text>
                  </TableHead>
                </If>
                <TableHead class="w-24 shrink-0">
                  <Text class="text-xs font-medium text-muted-foreground">Capabilities</Text>
                </TableHead>
                <TableHead class="w-20 shrink-0 items-end">
                  <Text class="text-xs font-medium text-muted-foreground">Enabled</Text>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <Each of={filteredModels()} key={(model) => model.id}>
                {(model) => {
                  const displayName = () => resolveEffectiveDisplayName(model());
                  const caps = () => resolveEffectiveCapabilities(model());
                  const apiDisplay = () =>
                    formatModelApiTypeDisplay(model(), props.channel.adapterId);
                  const contextText = () => formatTokenCount(model().contextLimit);
                  const maxTokText = () => formatTokenCount(model().maxTokens);
                  const isRowSelected = () => selectedIds().includes(model().id);

                  return (
                    <TableRow testID={`model-row-${model().modelKey}`}>
                      <If when={selectionMode()}>
                        <TableCell class="w-7 shrink-0">
                          <Checkbox
                            testID={`select-model-${model().modelKey}`}
                            accessibilityLabel={`Select ${displayName()}`}
                            checked={isRowSelected()}
                            onChange={(checked) => toggleRowSelection(model().id, checked)}
                          />
                        </TableCell>
                      </If>

                      <TableCell class="min-w-0 flex-1 gap-0.5">
                        <View class="flex-row flex-wrap items-center gap-1.5">
                          <Text class="min-w-0 truncate text-sm font-medium text-foreground">
                            {displayName()}
                          </Text>
                          <If when={model().syncStatus === "missing"}>
                            <Badge label="Missing" tone="warning" />
                          </If>
                          <If when={model().origin === "manual"}>
                            <Badge label="Manual" tone="neutral" />
                          </If>
                        </View>
                        <View class="flex-row flex-wrap items-center gap-2">
                          <Text class="truncate text-xs text-muted-foreground">
                            {model().modelKey}
                          </Text>
                          <If when={compactColumns()}>
                            <Text class="truncate text-xs text-muted-foreground">
                              {apiDisplay()}
                            </Text>
                          </If>
                          <If when={contextText() !== null}>
                            <Text class="text-xs text-muted-foreground">
                              {`${contextText()} ctx`}
                            </Text>
                          </If>
                          <If when={maxTokText() !== null}>
                            <Text class="text-xs text-muted-foreground">
                              {`${maxTokText()} out`}
                            </Text>
                          </If>
                        </View>
                      </TableCell>

                      <If when={!compactColumns()}>
                        <TableCell class="w-28 shrink-0">
                          <Text class="truncate text-xs text-muted-foreground">{apiDisplay()}</Text>
                        </TableCell>
                      </If>

                      <TableCell class="w-24 shrink-0">
                        <CapabilityIcons capabilities={caps()} />
                      </TableCell>

                      <TableCell class="w-20 shrink-0 flex-row items-center justify-end gap-1.5">
                        <Button
                          testID={`configure-model-${model().modelKey}`}
                          size="icon-sm"
                          variant="ghost"
                          tooltip="Configure"
                          accessibilityLabel={`Configure ${displayName()}`}
                          onPress={() => props.onConfigureModel(model())}
                        >
                          <Icon name="edit" tone="muted-foreground" class="size-3.5" />
                        </Button>
                        <Switch
                          testID={`toggle-model-${model().modelKey}`}
                          variant="inline"
                          accessibilityLabel={`Enable ${displayName()}`}
                          checked={model().enabled}
                          onChange={(checked) => void handleToggleEnabled(model(), checked)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                }}
              </Each>
            </TableBody>
          </Table>
        </If>
      </View>

      <ConfirmDialog
        testID="bulk-delete-models-dialog"
        open={bulkDeleteOpen()}
        onOpenChange={(open) => bulkDeleteOpen.set(open)}
        title="Delete Models"
        description={`Delete ${selectedIds().length} selected ${selectedIds().length === 1 ? "model" : "models"} from ${props.channel.displayName}?`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        busy={bulkDeleting()}
        onConfirm={() => void handleConfirmBulkDelete()}
      />
    </>
  );
}
