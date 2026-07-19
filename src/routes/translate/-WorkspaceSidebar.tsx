// ABOUTME: Left-rail workspace list for the main Translate page.
// ABOUTME: Select, create, rename (double-click), and delete workspaces.
import { useEffect, useRef, useState } from "react";
import { Button } from "@base-ui/react/button";
import { useTranslation } from "react-i18next";
import IconMaterialSymbolsLightAdd from "~icons/material-symbols-light/add";
import IconMaterialSymbolsLightClose from "~icons/material-symbols-light/close";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { iconButtonClassName } from "../../components/ui";
import { cn } from "../../lib/cn";
import { MAX_TRANSLATE_WORKSPACES, MAX_WORKSPACE_NAME_LENGTH, type TranslateWorkspace } from "./-workspaces";

export type WorkspaceSidebarProps = {
  workspaces: TranslateWorkspace[];
  activeWorkspaceId: string;
  disabled?: boolean;
  onSelect: (workspaceId: string) => void;
  onCreate: () => void;
  onRename: (workspaceId: string, name: string) => void;
  onDelete: (workspaceId: string) => void;
};

const railWidthClassName = "w-48";

export function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  disabled = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
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

  return (
    <>
      <aside
        className={cn(
          "shadow-frame flex shrink-0 flex-col border border-line bg-surface",
          railWidthClassName,
          "min-h-0",
        )}
        aria-label={t("translate.workspace.listAria")}
      >
        <div className="flex h-control-height shrink-0 items-center justify-between border-b border-line bg-surface-2 px-2">
          <span className="text-label-sm font-bold tracking-wide text-on-surface uppercase">
            {t("translate.workspace.title")}
          </span>
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

        <ul
          className="min-h-0 flex-1 list-none overflow-y-auto p-0"
          role="listbox"
          aria-label={t("translate.workspace.listAria")}
        >
          {workspaces.map((workspace) => {
            const selected = workspace.id === activeWorkspaceId;
            const isEditing = editingId === workspace.id;

            return (
              <li key={workspace.id} role="option" aria-selected={selected}>
                <div
                  className={cn(
                    "group flex items-center gap-1 border-l-4 px-2 py-2 transition-colors",
                    selected ? "border-tertiary bg-surface-2" : "border-transparent hover:bg-surface-2",
                    disabled ? "opacity-70" : "cursor-pointer",
                  )}
                >
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      className="h-7 min-w-0 flex-1 border border-line bg-surface px-1.5 text-body-tight text-on-surface outline-none focus:outline-2 focus:-outline-offset-1 focus:outline-on-surface"
                      value={draftName}
                      maxLength={MAX_WORKSPACE_NAME_LENGTH}
                      aria-label={t("translate.workspace.renameAria")}
                      onChange={(event) => {
                        setDraftName(event.currentTarget.value);
                      }}
                      onBlur={() => {
                        commitRename();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-body-tight text-on-surface"
                      disabled={disabled}
                      title={workspace.name}
                      onClick={() => {
                        if (!selected) {
                          onSelect(workspace.id);
                        }
                      }}
                      onDoubleClick={() => {
                        beginRename(workspace);
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
                      setDeleteTarget(workspace);
                    }}
                  >
                    <IconMaterialSymbolsLightClose className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
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
