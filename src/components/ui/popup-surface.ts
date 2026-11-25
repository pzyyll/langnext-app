import { motion } from "../motion";

/** Shared floating dropdown surface and item geometry for Select and Menu overlays. */
export const DROPDOWN_POPUP_SURFACE = `rounded-2xl border border-border bg-popover p-1 shadow-card dark:shadow-card-dark ${motion.popup}`;

export const DROPDOWN_ITEM_GEOMETRY = `my-px rounded-xl px-3 py-2 ${motion.navigationFeedback}`;
