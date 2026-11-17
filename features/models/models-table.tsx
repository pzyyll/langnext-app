import { effect, signal, Text, View, windowSize } from "nsh";
import { t } from "nsh/i18n";
import { motion } from "../../components/motion";
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
import {
  formatModelApiTypeDisplay,
  formatSyncTimestamp,
  formatTokenCount,
  resolveEffectiveCapabilities,
  resolveEffectiveDisplayName,
} from "./model-helpers";
import type { CapabilityFlags, ProviderModel } from "../../modules/ai/contracts/model";
import type { ProviderChannel } from "../../modules/ai/contracts/channel";
import type { ModelsEnabledFilter } from "./types";

const filterItems = (): SelectItem[] => [
  { value: "all", title: t("models.filter.all") },
  { value: "enabled", title: t("models.filter.enabled") },
  { value: "disabled", title: t("models.filter.disabled") },
];

const CAPABILITY_ITEMS: ReadonlyArray<{
  key: keyof CapabilityFlags;
  icon: IconName;
  labelKey: string;
}> = [
  { key: "text", icon: "file-text", labelKey: "models.capability.text" },
  { key: "image", icon: "pic", labelKey: "models.capability.image" },
  { key: "pdf", icon: "file-pdf", labelKey: "models.capability.pdf" },
  { key: "video", icon: "video", labelKey: "models.capability.video" },
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
            accessibilityLabel={t(item().labelKey)}
            tooltip={buildTooltip(t(item().labelKey), "top")}
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
  testing: boolean;
  syncing: boolean;
  /** The channel's provider is unavailable: hide actions no registered module can serve. */
  disabled?: boolean;
  /** The current channel protocol is unusable, so remote actions wait for a correction. */
  connectionBlocked?: boolean;
  onGetModels: () => void;
  onEnabledFilterChange: (filter: ModelsEnabledFilter) => void;
  onAddModel: () => void;
  onConfigureModel: (model: ProviderModel) => void;
  onToggleModelEnabled: (model: ProviderModel, checked: boolean) => Promise<void> | void;
  onDeleteModels: (modelIds: string[]) => Promise<number> | number;
}

/** Models toolbar, remote sync controls, filterable table, and bulk deletion. */
export function ModelsTable(props: ModelsTableProps) {
  const searchQuery = signal("");
  const selectionMode = signal(false);
  const selectedIds = signal<string[]>([]);
  const bulkDeleteOpen = signal(false);
  const bulkDeleting = signal(false);

  let lastChannelId = "";

  effect(() => {
    const channelId = props.channel.id;
    if (channelId !== lastChannelId) {
      lastChannelId = channelId;
      searchQuery.set("");
      selectionMode.set(false);
      selectedIds.set([]);
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

  const handleToggleEnabled = async (model: ProviderModel, checked: boolean) => {
    try {
      await props.onToggleModelEnabled(model, checked);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.updateModelState"));
    }
  };

  const handleConfirmBulkDelete = async () => {
    const ids = selectedIds();
    if (ids.length === 0 || bulkDeleting()) return;
    bulkDeleting.set(true);
    try {
      const count = await props.onDeleteModels(ids);
      toast.success(
        count === 1
          ? t("models.delete.modelsDoneOne", { count })
          : t("models.delete.modelsDone", { count }),
      );
      selectedIds.set([]);
      selectionMode.set(false);
      bulkDeleteOpen.set(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("models.error.deleteModels"));
    } finally {
      bulkDeleting.set(false);
    }
  };

  const compactColumns = () => windowSize().width < 860;

  const syncStatusLabel = () => {
    if (props.channel.modelsLastSyncError) {
      return t("models.connection.syncError", { error: props.channel.modelsLastSyncError });
    }
    const ts = formatSyncTimestamp(props.channel.modelsLastSyncedAt);
    return ts ? t("models.connection.syncedAt", { time: ts }) : t("models.connection.neverSynced");
  };

  return (
    <>
      <View class="gap-3.5">
        <View class="flex-row flex-wrap items-start justify-between gap-3">
          <View class="min-w-0 gap-0.5">
            <View class="flex-row items-center gap-2">
              <SectionHeading title={t("models.title")} />
              <If when={props.models.length > 0}>
                <Badge label={String(props.models.length)} tone="neutral" />
              </If>
            </View>
            <Text
              class={
                props.channel.modelsLastSyncError
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {syncStatusLabel()}
            </Text>
          </View>

          <View class="flex-row flex-wrap items-center gap-2">
            <Button
              testID="get-models-button"
              variant="outline"
              size="sm"
              label={
                props.syncing ? t("models.connection.fetching") : t("models.connection.getModels")
              }
              disabled={props.syncing || props.testing || props.connectionBlocked || props.disabled}
              onPress={() => props.onGetModels()}
            />
          </View>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <Input
            testID="models-search-input"
            size="sm"
            leadingIcon="search"
            placeholder={t("models.search.placeholder")}
            accessibilityLabel={t("models.search.label")}
            clearLabel={t("models.search.clear")}
            value={searchQuery()}
            onChange={(v) => searchQuery.set(v)}
            onClear={() => searchQuery.set("")}
            class="min-w-40 flex-1"
          />
          <Select
            testID="models-filter-select"
            size="sm"
            accessibilityLabel={t("models.filter.label")}
            items={filterItems()}
            value={props.enabledFilter}
            onChange={(v) => {
              if (v) props.onEnabledFilterChange(v as ModelsEnabledFilter);
            }}
            triggerClass="w-28"
          />
          <Button
            testID="add-model-button"
            variant="outline"
            size="sm"
            accessibilityLabel={t("models.model.add")}
            disabled={props.disabled}
            onPress={() => props.onAddModel()}
          >
            <Icon name="plus" tone="foreground" class="size-3.5" />
            <Text class="text-sm font-medium text-foreground">{t("models.model.add")}</Text>
          </Button>
          <If when={props.models.length > 0}>
            <If
              when={selectionMode()}
              else={
                <Button
                  testID="select-models-button"
                  variant="outline"
                  size="sm"
                  label={t("models.action.select")}
                  onPress={() => selectionMode.set(true)}
                />
              }
            >
              <View class="flex-row items-center gap-2">
                <Button
                  testID="bulk-delete-models-button"
                  variant="destructive"
                  size="sm"
                  label={t("models.action.deleteSelected", { count: selectedIds().length })}
                  disabled={selectedIds().length === 0}
                  onPress={() => bulkDeleteOpen.set(true)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  label={t("common.done")}
                  onPress={() => {
                    selectionMode.set(false);
                    selectedIds.set([]);
                  }}
                />
              </View>
            </If>
          </If>
        </View>

        <If
          when={filteredModels().length > 0}
          else={
            <View class="items-center justify-center gap-2 py-8">
              <Icon
                name={props.models.length === 0 ? "cube-outline" : "search"}
                tone="muted-foreground"
                class="size-7 opacity-40"
              />
              <Text class="text-sm text-muted-foreground">
                {props.models.length === 0 ? t("models.model.empty") : t("models.model.noMatch")}
              </Text>
              <If when={props.models.length > 0}>
                <Button
                  variant="ghost"
                  size="xs"
                  label={t("models.search.reset")}
                  onPress={() => {
                    searchQuery.set("");
                    props.onEnabledFilterChange("all");
                  }}
                />
              </If>
            </View>
          }
        >
          <Table accessibilityLabel={t("models.model.listLabel")}>
            <TableHeader>
              <TableRow class="py-2">
                <If when={selectionMode()}>
                  <TableHead class="w-7 shrink-0">
                    <Checkbox
                      testID="select-all-models-checkbox"
                      accessibilityLabel={t("models.model.selectAll")}
                      checked={allVisibleSelected()}
                      indeterminate={someVisibleSelected() && !allVisibleSelected()}
                      onChange={toggleSelectAll}
                    />
                  </TableHead>
                </If>
                <TableHead class="min-w-0 flex-1">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {t("models.column.model")}
                  </Text>
                </TableHead>
                <If when={!compactColumns()}>
                  <TableHead class="w-40 shrink-0">
                    <Text class="text-xs font-medium text-muted-foreground">
                      {t("models.column.apiType")}
                    </Text>
                  </TableHead>
                </If>
                <TableHead class="w-24 shrink-0">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {t("models.column.capabilities")}
                  </Text>
                </TableHead>
                <TableHead class="w-20 shrink-0 items-end">
                  <Text class="text-xs font-medium text-muted-foreground">
                    {t("models.column.enabled")}
                  </Text>
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
                    <TableRow
                      testID={`model-row-${model().modelKey}`}
                      class={`hover:bg-muted/40 ${motion.navigationFeedback}`}
                    >
                      <If when={selectionMode()}>
                        <TableCell class="w-7 shrink-0">
                          <Checkbox
                            testID={`select-model-${model().modelKey}`}
                            accessibilityLabel={t("models.model.select", { name: displayName() })}
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
                            <Badge label={t("models.badge.missing")} tone="warning" />
                          </If>
                          <If when={model().origin === "manual"}>
                            <Badge label={t("models.badge.manual")} tone="neutral" />
                          </If>
                        </View>
                        <View class="flex-row flex-wrap items-center gap-2">
                          <Text class="truncate font-mono text-xs text-muted-foreground">
                            {model().modelKey}
                          </Text>
                          <If when={compactColumns()}>
                            <Text class="truncate text-xs text-muted-foreground">
                              {apiDisplay()}
                            </Text>
                          </If>
                          <If when={contextText() !== null}>
                            <Text class="text-xs tabular-nums text-muted-foreground">
                              {t("models.token.context", { value: contextText() })}
                            </Text>
                          </If>
                          <If when={maxTokText() !== null}>
                            <Text class="text-xs tabular-nums text-muted-foreground">
                              {t("models.token.max", { value: maxTokText() })}
                            </Text>
                          </If>
                        </View>
                      </TableCell>

                      <If when={!compactColumns()}>
                        <TableCell class="w-40 shrink-0">
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
                          tooltip={t("models.model.configured")}
                          accessibilityLabel={t("models.model.configureLabel", {
                            name: displayName(),
                          })}
                          disabled={props.disabled}
                          onPress={() => props.onConfigureModel(model())}
                        >
                          <Icon name="edit" tone="muted-foreground" class="size-3.5" />
                        </Button>
                        <Switch
                          testID={`toggle-model-${model().modelKey}`}
                          variant="inline"
                          accessibilityLabel={t("models.model.enableLabel", {
                            name: displayName(),
                          })}
                          checked={model().enabled}
                          disabled={props.disabled}
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
        title={t("models.delete.modelsTitle")}
        description={
          selectedIds().length === 1
            ? t("models.delete.modelsDescriptionOne", {
                count: selectedIds().length,
                channel: props.channel.displayName,
              })
            : t("models.delete.modelsDescription", {
                count: selectedIds().length,
                channel: props.channel.displayName,
              })
        }
        confirmLabel={t("common.delete")}
        confirmVariant="destructive"
        busy={bulkDeleting()}
        onConfirm={() => void handleConfirmBulkDelete()}
      />
    </>
  );
}
