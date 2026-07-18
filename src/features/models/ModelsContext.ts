// ABOUTME: Layout-only coordination for Models sidebar enter/exit animations.
// ABOUTME: Authoritative provider records live in TanStack Query, not this context.
import { createContext, useContext } from "react";
import type { ProviderInstanceDto } from "../../storage/types";

export type ModelsContextValue = {
  /** Mark a newly created provider for enter animation. */
  markProviderEnter: (id: string) => void;
  /** Keep a deleted provider visible until the exit animation finishes. */
  beginProviderExit: (provider: ProviderInstanceDto) => void;
};

export const ModelsContext = createContext<ModelsContextValue | null>(null);

/** Access models layout context; throws when used outside ModelsLayout. */
export function useModelsContext(): ModelsContextValue {
  const value = useContext(ModelsContext);
  if (!value) {
    throw new Error("useModelsContext must be used within ModelsLayout");
  }
  return value;
}
