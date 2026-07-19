// ABOUTME: Left-rail workspace list for the main Translate page.
// ABOUTME: Select, create, rename, delete, drag-reorder, and collapse the rail.
import { useEffect, useRef, useState } from "react";
import { Button } from "@base-ui/react/button";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightLeftPanelClose from "~icons/material-symbols-light/left-panel-close";
import IconMaterialSymbolsLightLeftPanelOpen from "~icons/material-symbols-light/left-panel-open";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { iconButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { MAX_TRANSLATE_WORKSPACES, MAX_WORKSPACE_NAME_LENGTH, type TranslateWorkspace } from "./-workspaces";

export type WorkspaceSidebarProps = {
  workspaces: TranslateWorkspace[];
  activeWorkspaceId: string;
  collapsed: boolean;
  disabled?: boolean;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onRename: (workspaceId: string, name: string) => void;
  onDelete: (workspaceId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onCollapsedChange: (collapsed: boolean) => void;
};

const railExpandedWidthClassName = "w-48";
const railCollapsedWidthClassName = "w-10";

function SortableWorkspaceRow({
  workspace,
  index,
  selected,
  disabled,
  isEditing,
  draftName,
  inputRef,
  onSelect,
  onBeginRename,
  onDraftNameChange,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
}: {
  workspace: TranslateWorkspace;
  index: number;
  selected: boolean;
  disabled: boolean;
  isEditing: boolean;
  draftName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: () => void;
  onBeginRename: () => void;
  onDraftNameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslation();
  const { ref, handleRef } = useSortable({
    id: workspace.id,
    index,
    disabled: disabled || isEditing,
  });

  return (
    <li ref={ref} role="option" aria-selected={selected}>
      <div
        className={cn(
          "group flex items-center gap-0.5 border-l-4 py-1.5 pr-1 pl-0.5 transition-colors",
          selected ? "border-tertiary bg-surface-2" : "border-transparent hover:bg-surface-2",
          disabled ? "opacity-70" : "",
        )}
      >
        <button
          ref={handleRef}
          type="button"
          aria-label={t("translate.workspace.reorderAria", { name: workspace.name })}
          disabled={disabled || isEditing}
          className={cn(
            "w-5 shrink-0 cursor-grab text-center text-[10px] leading-none text-neutral active:cursor-grabbing",
            selected ? "text-on-surface" : "group-hover:text-on-surface",
            (disabled || isEditing) && "cursor-default opacity-40",
          )}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>

        {isEditing ? (
          <input
            ref={inputRef}
            className="h-7 min-w-0 flex-1 border border-line bg-surface px-1.5 text-body-tight text-on-surface outline-none focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface"
            value={draftName}
            maxLength={MAX_WORKSPACE_NAME_LENGTH}
            aria-label={t("translate.workspace.renameAria")}
            onChange={(event) => {
              onDraftNameChange(event.currentTarget.value);
            }}
            onBlur={() => {
              onCommitRename();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename();
              }
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate py-0.5 text-left text-body-tight text-on-surface"
            disabled={disabled}
            title={workspace.name}
            onClick={() => {
              if (!selected) {
                onSelect();
              }
            }}
            onDoubleClick={() => {
              onBeginRename();
            }}
          >
            <span className={cn(selected ? "font-bold" : "font-normal")}>{workspace.name}</span>
          </button>
        )}

        <Button
          type="button"
          className={cn(
            iconButtonClassName,
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            selected && "opacity-100",
          )}
          aria-label={t("translate.workspace.deleteAria", { name: workspace.name })}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onRequestDelete();
          }}
        >
          <IconMaterialSymbolsLightClose className="size-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  collapsed,
  disabled = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onReorder,
  onCollapsedChange,
}: WorkspaceSidebarProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<TranslateWorkspace | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const atLimit = workspaces.length >= MAX_TRANSLATE_WORKSPACES;
  const canCreate = !disabled && !atLimit;
  const activeWorkspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0] ?? null;

  function beginRename(workspace: TranslateWorkspace) {
    if (disabled) {
      return;
    }
    setEditingId(workspace.id);
    setDraftName(workspace.name);
  }

  function commitRename() {
    if (!editingId) {
      return;
    }
    const trimmed = draftName.trim();
    if (trimmed.length > 0) {
      onRename(editingId, trimmed.slice(0, MAX_WORKSPACE_NAME_LENGTH));
    }
    setEditingId(null);
    setDraftName("");
  }

  function cancelRename() {
    setEditingId(null);
    setDraftName("");
  }

  if (collapsed) {
    return (
      <aside
        className={cn(
          "shadow-frame flex shrink-0 flex-col items-center border border-line bg-surface py-1",
          railCollapsedWidthClassName,
          "min-h-0",
        )}
        aria-label={t("translate.workspace.listAria")}
      >
        <Button
          type="button"
          className={iconButtonClassName}
          aria-label={t("translate.workspace.expandAria")}
          aria-expanded={false}
          title={activeWorkspace?.name}
          onClick={() => {
            onCollapsedChange(false);
          }}
        >
          <IconMaterialSymbolsLightLeftPanelOpen className="size-4" aria-hidden />
        </Button>
        {activeWorkspace ? (
          <span
            className="mt-2 max-h-40 w-full truncate px-1 text-center text-[10px] font-bold tracking-wide text-neutral uppercase [writing-mode:vertical-rl]"
            title={activeWorkspace.name}
          >
            {activeWorkspace.name}
          </span>
        ) : null}
      </aside>
    );
  }

  return (
    <>
      <aside
        className={cn(
          "shadow-frame flex shrink-0 flex-col border border-line bg-surface",
          railExpandedWidthClassName,
          "min-h-0",
        )}
        aria-label={t("translate.workspace.listAria")}
      >
        <div className="flex h-control-height shrink-0 items-center justify-between gap-1 border-b border-line bg-surface-2 px-1">
          <span className="min-w-0 flex-1 truncate pl-1 text-label-sm font-bold tracking-wide text-on-surface uppercase">
            {t("translate.workspace.title")}
          </span>
          <Button
            type="button"
            className={iconButtonClassName}
            aria-label={t("translate.workspace.collapseAria")}
            aria-expanded={true}
            onClick={() => {
              setEditingId(null);
              setDraftName("");
              onCollapsedChange(true);
            }}
          >
            <IconMaterialSymbolsLightLeftPanelClose className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            className={iconButtonClassName}
            aria-label={t("translate.workspace.addAria")}
            disabled={!canCreate}
            title={atLimit ? t("translate.workspace.limitReached", { max: MAX_TRANSLATE_WORKSPACES }) : undefined}
            onClick={() => {
              onCreate();
            }}
          >
            <IconMaterialSymbolsLightAdd className="size-4" aria-hidden />
          </Button>
        </div>

        <DragDropProvider
          onDragEnd={(event) => {
            if (event.canceled || disabled) {
              return;
            }
            const { source } = event.operation;
            if (!isSortable(source)) {
              return;
            }
            const { initialIndex, index } = source;
            if (initialIndex === index) {
              return;
            }
            const next = workspaces.slice();
            const [removed] = next.splice(initialIndex, 1);
            if (!removed) {
              return;
            }
            next.splice(index, 0, removed);
            onReorder(next.map((ws) => ws.id));
          }}
        >
          <ul
            className="min-h-0 flex-1 list-none overflow-y-auto p-0"
            role="listbox"
            aria-label={t("translate.workspace.listAria")}
          >
            {workspaces.map((workspace, index) => {
              const selected = workspace.id === activeWorkspaceId;
              const isEditing = editingId === workspace.id;
              return (
                <SortableWorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  index={index}
                  selected={selected}
                  disabled={disabled}
                  isEditing={isEditing}
                  draftName={draftName}
                  inputRef={inputRef}
                  onSelect={() => {
                    onSelect(workspace.id);
                  }}
                  onBeginRename={() => {
                    beginRename(workspace);
                  }}
                  onDraftNameChange={setDraftName}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                  onRequestDelete={() => {
                    setDeleteTarget(workspace);
                  }}
                />
              );
            })}
          </ul>
        </DragDropProvider>
      </aside>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        title={t("translate.workspace.deleteTitle")}
        description={deleteTarget ? t("translate.workspace.deleteConfirm", { name: deleteTarget.name }) : undefined}
        confirmText={t("common.delete")}
        danger
        onConfirm={() => {
          if (deleteTarget) {
            onDelete(deleteTarget.id);
          }
        }}
      />
    </>
  );
}
