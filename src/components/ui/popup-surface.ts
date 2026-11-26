import { motion } from "../motion";

/** Shared floating surface border, background, and elevation for popovers, menus, and selects. */
export const FLOATING_POPUP_SURFACE =
  "rounded-2xl border border-border bg-popover shadow-card dark:shadow-card-dark";

/** Shared floating dropdown surface and item geometry for Select and Menu overlays. */
export const DROPDOWN_POPUP_SURFACE = `${FLOATING_POPUP_SURFACE} p-1 ${motion.popup}`;

export const DROPDOWN_ITEM_GEOMETRY = `my-px rounded-xl px-3 py-2 ${motion.navigationFeedback}`;
