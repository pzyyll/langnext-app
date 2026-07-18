// ABOUTME: Class-name helper that combines conditional class lists with Tailwind conflict resolution.
// ABOUTME: Prefer cn() over string templates when composing or overriding utility classes.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class values and drop conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
