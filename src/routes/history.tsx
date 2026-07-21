// ABOUTME: History route: draft/applied filters, paged table, detail dialog, CSV export, delete/clear.
// ABOUTME: Selection is current-page only; flipping the page clears the selection.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageLayout } from "../components/layouts/PageLayout";
import { useToast } from "../components/toast/useToast";
import { dangerButtonClassName, outlineButtonClassName } from "../components/ui";
import { HistoryDetailDialog } from "../features/history/HistoryDetailDialog";
import { HistoryFilters, type HistoryFilterDraft } from "../features/history/HistoryFilters";
import { HistoryTable } from "../features/history/HistoryTable";
import { isFsError } from "../features/fsError";
import { exportHistoryCsv } from "../features/history/historyExport";
import { historyListOptions, historyModelFacetsOptions } from "../query/options";
import { historyKeys } from "../query/keys";
import {
  deleteAllTranslationHistory,
  deleteTranslationHistory,
  getTranslationHistory,
  getTranslationHistoryMany,
} from "../storage/client";
import { getIpcErrorMessage } from "../storage/errors";
import type { TranslationHistoryListQuery } from "../storage/types";

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

const DEFAULT_PAGE_SIZE = 20;
const EMPTY_DRAFT: HistoryFilterDraft = { search: "", modelId: "", language: "", date: "" };

type DeleteTarget = { kind: "selected"; ids: string[] } | { kind: "single"; id: string } | null;

function HistoryPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [draft, setDraft] = useState<HistoryFilterDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<HistoryFilterDraft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);

  // Client UTC offset in minutes (positive east of UTC) for local-day date filtering.
  const offsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  const facetsQuery = useQuery(historyModelFacetsOptions());

  const listQuery: TranslationHistoryListQuery = useMemo(
    () => ({
      search: applied.search.trim() || null,
      modelId: applied.modelId || null,
      language: applied.language || null,
      date: applied.date || null,
      offsetMinutes,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    }),
    [applied, offsetMinutes, page],
  );
  const listResult = useQuery(historyListOptions(listQuery));

  const totalPages = Math.max(1, Math.ceil((listResult.data?.total ?? 0) / DEFAULT_PAGE_SIZE));
  const from = listResult.data && listResult.data.total > 0 ? (page - 1) * DEFAULT_PAGE_SIZE + 1 : 0;
  const to = listResult.data ? Math.min(page * DEFAULT_PAGE_SIZE, listResult.data.total) : 0;

  function patchDraft(patch: Partial<HistoryFilterDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleApply() {
    setApplied(draft);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleClear() {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handlePageChange(next: number) {
    const clamped = Math.min(Math.max(1, next), totalPages);
    setSelectedIds(new Set());
    setPage(clamped);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll(checked: boolean, visibleIds: readonly string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const id of visibleIds) {
          next.add(id);
        }
      } else {
        for (const id of visibleIds) {
          next.delete(id);
        }
      }
      return next;
    });
  }

  const deleteManyMutation = useMutation({
    mutationFn: (ids: string[]) => deleteTranslationHistory(ids),
    onSuccess: (_data, ids) => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.all });
      toast.success({ title: t("history.toast.deleteSuccess", { count: ids.length }) });
      setSelectedIds(new Set());
      setDeleteTarget(null);
    },
    onError: (err) => {
      toast.error({
        title: t("history.toast.deleteFailed"),
        description: getIpcErrorMessage(err, t("history.toast.deleteFailed")),
      });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: () => deleteAllTranslationHistory(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.all });
      toast.success({ title: t("history.toast.clearSuccess") });
      setClearAllOpen(false);
      setSelectedIds(new Set());
    },
    onError: (err) => {
      toast.error({
        title: t("history.toast.clearFailed"),
        description: getIpcErrorMessage(err, t("history.toast.clearFailed")),
      });
    },
  });

  async function handleCopy(id: string) {
    try {
      const dto = await getTranslationHistory(id);
      if (!dto.translatedText) {
        return;
      }
      await navigator.clipboard.writeText(dto.translatedText);
      toast.success({ title: t("history.detail.copied") });
    } catch (err) {
      toast.error({
        title: t("history.toast.copyFailed"),
        description: getIpcErrorMessage(err, t("history.toast.copyFailed")),
      });
    }
  }

  async function handleExportSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      toast.warning({ title: t("history.toast.exportEmpty") });
      return;
    }
    try {
      const rows = await getTranslationHistoryMany(ids);
      const written = await exportHistoryCsv(rows);
      if (written) {
        toast.success({ title: t("history.toast.exportSuccess", { count: rows.length }) });
      }
    } catch (err) {
      const description = isFsError(err)
        ? err.message.trim() || t("history.toast.exportFailed")
        : getIpcErrorMessage(err, t("history.toast.exportFailed"));
      toast.error({
        title: t("history.toast.exportFailed"),
        description,
      });
    }
  }

  function handleConfirmDelete() {
    if (deleteTarget?.kind === "single") {
      deleteManyMutation.mutate([deleteTarget.id]);
    } else if (deleteTarget?.kind === "selected") {
      deleteManyMutation.mutate(deleteTarget.ids);
    }
  }

  const isClearing = deleteAllMutation.isPending;
  const total = listResult.data?.total ?? 0;
  const deleteConfirmCount =
    deleteTarget?.kind === "single" ? 1 : deleteTarget?.kind === "selected" ? deleteTarget.ids.length : 0;

  return (
    <>
      <PageLayout
        title={t("history.title")}
        description={t("history.description")}
        contentClassName="flex-col gap-4 overflow-y-auto p-gutter"
        actions={
          <button
            type="button"
            className={dangerButtonClassName}
            onClick={() => setClearAllOpen(true)}
            disabled={total === 0 || isClearing}
          >
            {t("history.clearAll")}
          </button>
        }
      >
        <HistoryFilters
          draft={draft}
          onDraftChange={patchDraft}
          modelFacets={facetsQuery.data ?? []}
          onApply={handleApply}
          onClear={handleClear}
          disabled={listResult.isFetching}
        />

        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-3 border border-line bg-surface-2 px-3 py-2">
            <span className="text-body-tight text-on-surface">
              {t("history.bulk.selected", { count: selectedIds.size })}
            </span>
            <div className="ml-auto flex gap-2">
              <button type="button" className={outlineButtonClassName} onClick={() => void handleExportSelected()}>
                {t("history.bulk.exportSelected")}
              </button>
              <button
                type="button"
                className={dangerButtonClassName}
                onClick={() => setDeleteTarget({ kind: "selected", ids: [...selectedIds] })}
              >
                {t("history.bulk.deleteSelected", { count: selectedIds.size })}
              </button>
            </div>
          </div>
        ) : null}

        {listResult.isLoading ? (
          <p className="text-body-tight text-neutral" role="status">
            {t("history.loading")}
          </p>
        ) : listResult.error ? (
          <p className="text-body-tight text-error" role="alert">
            {t("history.loadFailed")}
          </p>
        ) : listResult.data && listResult.data.items.length > 0 ? (
          <HistoryTable
            items={listResult.data.items}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            onView={(id) => setDetailId(id)}
            onCopy={(item) => void handleCopy(item.id)}
            onDelete={(id) => setDeleteTarget({ kind: "single", id })}
          />
        ) : (
          <div className="flex flex-col gap-1 border border-line bg-surface p-gutter text-neutral">
            <p className="text-body-md font-bold text-on-surface">{t("history.empty")}</p>
            <p className="text-body-tight">{t("history.emptyHint")}</p>
          </div>
        )}

        {listResult.data && listResult.data.total > 0 ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-body-tight text-neutral">{t("history.pagination.showing", { from, to, total })}</span>
            <div className="flex gap-1">
              <button
                type="button"
                className={outlineButtonClassName}
                aria-label={t("history.pagination.first")}
                onClick={() => handlePageChange(1)}
                disabled={page <= 1}
              >
                «
              </button>
              <button
                type="button"
                className={outlineButtonClassName}
                aria-label={t("history.pagination.prev")}
                onClick={() => handlePageChange(page - 1)}
                disabled={page <= 1}
              >
                ‹
              </button>
              <span className="px-2 text-body-tight text-neutral">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                className={outlineButtonClassName}
                aria-label={t("history.pagination.next")}
                onClick={() => handlePageChange(page + 1)}
                disabled={page >= totalPages}
              >
                ›
              </button>
              <button
                type="button"
                className={outlineButtonClassName}
                aria-label={t("history.pagination.last")}
                onClick={() => handlePageChange(totalPages)}
                disabled={page >= totalPages}
              >
                »
              </button>
            </div>
          </div>
        ) : null}
      </PageLayout>

      <HistoryDetailDialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)} id={detailId} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("history.deleteConfirmTitle")}
        description={t("history.deleteConfirmDescription", { count: deleteConfirmCount })}
        confirmText={t("common.delete")}
        danger
        onConfirm={handleConfirmDelete}
      />

      <ConfirmDialog
        open={clearAllOpen}
        onOpenChange={setClearAllOpen}
        title={t("history.clearAllConfirmTitle")}
        description={t("history.clearAllConfirmDescription", { count: total })}
        confirmText={t("history.clearAll")}
        danger
        onConfirm={() => deleteAllMutation.mutate()}
      />
    </>
  );
}
