// ABOUTME: Left-rail workspace list for the main Translate page.
// ABOUTME: Select, create, rename, delete, drag-reorder, and collapse the rail.
import { useCallback, useEffect, useRef, useState } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import IconMaterialSymbolsLightLeftPanelClose from "~icons/material-symbols-light/left-panel-close";
import IconMaterialSymbolsLightLeftPanelOpen from "~icons/material-symbols-light/left-panel-open";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { IconButton } from "../../components/IconButton";
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
/** Expanded rail min-width so content layout stays fixed while width animates. */
const railExpandedMinWidthClassName = "min-w-48";
const railWidthTransitionClassName = "transition-[width] duration-200 ease-out motion-reduce:transition-none";
const railContentFadeClassName = "transition-opacity duration-150 ease-out motion-reduce:transition-none";

/** Slightly longer than CSS channel-exit (120ms) so missing animationend never sticks. */
const WORKSPACE_EXIT_FALLBACK_MS = 200;
/** Slightly longer than CSS channel-enter (150ms) to clear enter class. */
const WORKSPACE_ENTER_FALLBACK_MS = 250;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function SortableWorkspaceRow({
  workspace,
  index,
  selected,
  disabled,
  entering,
  exiting,
  isEditing,
  draftName,
  inputRef,
  onSelect,
  onBeginRename,
  onDraftNameChange,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  onEnterComplete,
  onExitComplete,
}: {
  workspace: TranslateWorkspace;
  index: number;
  selected: boolean;
  disabled: boolean;
  entering: boolean;
  exiting: boolean;
  isEditing: boolean;
  draftName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: () => void;
  onBeginRename: () => void;
  onDraftNameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  onEnterComplete: (id: string) => void;
  onExitComplete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { ref, handleRef } = useSortable({
    id: workspace.id,
    index,
    disabled: disabled || isEditing || exiting,
  });

  const exitDoneRef = useRef(false);
  const enterDoneRef = useRef(false);

  useEffect(() => {
    exitDoneRef.current = false;
    if (!exiting) return;

    const finish = () => {
      if (exitDoneRef.current) return;
      exitDoneRef.current = true;
      onExitComplete(workspace.id);
    };

    // No animation event when reduced motion disables CSS animation.
    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const timer = window.setTimeout(finish, WORKSPACE_EXIT_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [exiting, onExitComplete, workspace.id]);

  useEffect(() => {
    enterDoneRef.current = false;
    if (!entering || exiting) return;

    const finish = () => {
      if (enterDoneRef.current) return;
      enterDoneRef.current = true;
      onEnterComplete(workspace.id);
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const timer = window.setTimeout(finish, WORKSPACE_ENTER_FALLBACK_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [entering, exiting, onEnterComplete, workspace.id]);

  const animationClass = exiting
    ? "animate-channel-exit motion-reduce:animate-none"
    : entering
      ? "animate-channel-enter motion-reduce:animate-none"
      : "";

  return (
    <li ref={ref} role="option" aria-selected={selected}>
      <div
        className={cn(
          `group flex items-center gap-0.5 border-l-4 py-1.5 pr-1 pl-0.5 transition-colors`,
          animationClass,
          selected
            ? "border-tertiary bg-surface-container-low"
            : `
              border-transparent
              hover:bg-surface-container-highest
            `,
          disabled && !exiting ? "opacity-70" : "",
          exiting ? "pointer-events-none" : "",
        )}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          const name = event.animationName;
          if (exiting && name.includes("channel-exit")) {
            if (exitDoneRef.current) return;
            exitDoneRef.current = true;
            onExitComplete(workspace.id);
            return;
          }
          if (entering && !exiting && name.includes("channel-enter")) {
            if (enterDoneRef.current) return;
            enterDoneRef.current = true;
            onEnterComplete(workspace.id);
          }
        }}
      >
        <button
          ref={handleRef}
          type="button"
          aria-label={t("translate.workspace.reorderAria", { name: workspace.name })}
          disabled={disabled || isEditing || exiting}
          className={cn(
            `
              w-5 shrink-0 cursor-grab text-center text-[10px] leading-none text-neutral
              active:cursor-grabbing
            `,
            selected ? "text-on-surface" : "group-hover:text-on-surface",
            (disabled || isEditing || exiting) && "cursor-default opacity-40",
          )}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>

        {isEditing ? (
          <input
            ref={inputRef}
            className="
              h-7 min-w-0 flex-1 border border-line bg-surface px-1.5 text-body-tight text-on-surface outline-none
              focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface
            "
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
            disabled={disabled || exiting}
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

        <IconButton
          className={cn(
            `
              opacity-0
              group-focus-within:opacity-100
              group-hover:opacity-100
              [&_svg]:size-3.5
            `,
            selected && "opacity-100",
          )}
          aria-label={t("translate.workspace.deleteAria", { name: workspace.name })}
          disabled={disabled || exiting}
          onClick={(event) => {
            event.stopPropagation();
            onRequestDelete();
          }}
        >
          <IconMaterialSymbolsLightClose aria-hidden />
        </IconButton>
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
  /** IDs playing exit animation; kept in the list until animation ends, then deleted. */
  const [exitingWorkspaceIds, setExitingWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  /** IDs inserted via create; play enter animation. */
  const [enteringWorkspaceIds, setEnteringWorkspaceIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Sorted id fingerprint so first paint does not enter-animate existing rows. */
  const [trackedWorkspaceIdsKey, setTrackedWorkspaceIdsKey] = useState(() =>
    workspaces
      .map((workspace) => workspace.id)
      .slice()
      .sort()
      .join("\0"),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Adjust enter state during render when the workspace id set changes (React-supported).
  const workspaceIdsKey = workspaces
    .map((workspace) => workspace.id)
    .slice()
    .sort()
    .join("\0");
  if (workspaceIdsKey !== trackedWorkspaceIdsKey) {
    const previousIds = new Set(trackedWorkspaceIdsKey.length > 0 ? trackedWorkspaceIdsKey.split("\0") : []);
    const addedIds: string[] = [];
    for (const workspace of workspaces) {
      if (!previousIds.has(workspace.id)) {
        addedIds.push(workspace.id);
      }
    }
    setTrackedWorkspaceIdsKey(workspaceIdsKey);
    if (addedIds.length > 0) {
      setEnteringWorkspaceIds((current) => {
        const next = new Set(current);
        for (const id of addedIds) {
          next.add(id);
        }
        return next;
      });
    }
  }

  const clearEnteringWorkspace = useCallback((id: string) => {
    setEnteringWorkspaceIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const finalizeRemoveWorkspace = useCallback(
    (id: string) => {
      setExitingWorkspaceIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setEnteringWorkspaceIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      // Delete only after exit animation so the row stays in place.
      onDelete(id);
    },
    [onDelete],
  );

  const beginWorkspaceExit = useCallback(
    (workspace: TranslateWorkspace) => {
      setExitingWorkspaceIds((current) => {
        if (current.has(workspace.id)) return current;
        const next = new Set(current);
        next.add(workspace.id);
        return next;
      });
      setEnteringWorkspaceIds((current) => {
        if (!current.has(workspace.id)) return current;
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
      if (editingId === workspace.id) {
        setEditingId(null);
        setDraftName("");
      }
      // Switch content immediately; the row itself stays until exit animation ends.
      if (workspace.id === activeWorkspaceId) {
        const index = workspaces.findIndex((item) => item.id === workspace.id);
        let target: TranslateWorkspace | null = null;
        for (let i = index - 1; i >= 0; i -= 1) {
          const item = workspaces[i];
          if (item && !exitingWorkspaceIds.has(item.id)) {
            target = item;
            break;
          }
        }
        if (!target) {
          for (let i = index + 1; i < workspaces.length; i += 1) {
            const item = workspaces[i];
            if (item && item.id !== workspace.id && !exitingWorkspaceIds.has(item.id)) {
              target = item;
              break;
            }
          }
        }
        if (target) {
          onSelect(target.id);
        }
      }
    },
    [activeWorkspaceId, editingId, exitingWorkspaceIds, onSelect, workspaces],
  );

  const atLimit = workspaces.length >= MAX_TRANSLATE_WORKSPACES;
  const canCreate = !disabled && !atLimit;
  const activeWorkspace = workspaces.find((ws) => ws.id === activeWorkspaceId) ?? workspaces[0] ?? null;

  function beginRename(workspace: TranslateWorkspace) {
    if (disabled || exitingWorkspaceIds.has(workspace.id)) {
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

  return (
    <>
      <aside
        className={cn(
          `relative flex shrink-0 flex-col overflow-hidden border-r border-outline bg-surface-container-lowest`,
          railWidthTransitionClassName,
          collapsed ? railCollapsedWidthClassName : railExpandedWidthClassName,
          "min-h-0",
        )}
        aria-label={t("translate.workspace.listAria")}
      >
        {/* Expanded rail: fixed min-width so layout does not reflow during width animation. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            railExpandedMinWidthClassName,
            railContentFadeClassName,
            collapsed ? "pointer-events-none opacity-0" : "opacity-100",
          )}
          aria-hidden={collapsed}
          inert={collapsed}
        >
          <div
            className="
              flex h-12 shrink-0 items-center justify-between gap-1 border-b border-outline bg-surface-container-low
              px-1
            "
          >
            <span className="min-w-0 flex-1 truncate pl-1 text-label-sm font-bold tracking-wide text-on-surface uppercase">
              {t("translate.workspace.title")}
            </span>
            <IconButton
              aria-label={t("translate.workspace.collapseAria")}
              aria-expanded={true}
              tabIndex={collapsed ? -1 : undefined}
              onClick={() => {
                setEditingId(null);
                setDraftName("");
                onCollapsedChange(true);
              }}
            >
              <IconMaterialSymbolsLightLeftPanelClose aria-hidden />
            </IconButton>
            <IconButton
              aria-label={t("translate.workspace.addAria")}
              disabled={!canCreate}
              tabIndex={collapsed ? -1 : undefined}
              title={atLimit ? t("translate.workspace.limitReached", { max: MAX_TRANSLATE_WORKSPACES }) : undefined}
              onClick={() => {
                onCreate();
              }}
            >
              <IconMaterialSymbolsLightAdd aria-hidden />
            </IconButton>
          </div>

          <DragDropProvider
            onDragEnd={(event) => {
              if (event.canceled || disabled || collapsed) {
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
              // Skip rows mid-exit so a pending delete does not get reordered into the store.
              const persistIds = next.map((ws) => ws.id).filter((id) => !exitingWorkspaceIds.has(id));
              if (persistIds.length === 0) {
                return;
              }
              onReorder(persistIds);
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
                    disabled={disabled || collapsed}
                    entering={enteringWorkspaceIds.has(workspace.id)}
                    exiting={exitingWorkspaceIds.has(workspace.id)}
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
                    onEnterComplete={clearEnteringWorkspace}
                    onExitComplete={finalizeRemoveWorkspace}
                  />
                );
              })}
            </ul>
          </DragDropProvider>
        </div>

        {/* Collapsed rail: overlay so expand control stays usable at w-10. */}
        <div
          className={cn(
            "absolute inset-0 flex flex-col items-center py-1",
            railContentFadeClassName,
            collapsed ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          aria-hidden={!collapsed}
          inert={!collapsed}
        >
          <IconButton
            aria-label={t("translate.workspace.expandAria")}
            aria-expanded={false}
            tabIndex={collapsed ? undefined : -1}
            title={activeWorkspace?.name}
            onClick={() => {
              onCollapsedChange(false);
            }}
          >
            <IconMaterialSymbolsLightLeftPanelOpen aria-hidden />
          </IconButton>
          {activeWorkspace ? (
            <span
              className="
                mt-2 max-h-40 w-full truncate px-1 text-center text-[10px] font-bold tracking-wide text-neutral
                uppercase [writing-mode:vertical-rl]
              "
              title={activeWorkspace.name}
            >
              {activeWorkspace.name}
            </span>
          ) : null}
        </div>
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
          if (!deleteTarget) {
            return;
          }
          // onDelete runs in onExitComplete after the in-place exit animation.
          beginWorkspaceExit(deleteTarget);
        }}
      />
    </>
  );
}
