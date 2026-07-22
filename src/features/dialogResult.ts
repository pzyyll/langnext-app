// ABOUTME: Shared success shape for native save-dialog write workflows.
// ABOUTME: Cancel is a non-throwing success variant; write failures use FsError instead.

/** Result of a save dialog that either wrote a file or was cancelled by the user. */
export type DialogSaveResult = { readonly status: "written" } | { readonly status: "cancelled" };
