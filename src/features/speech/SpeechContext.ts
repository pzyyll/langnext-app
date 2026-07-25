// ABOUTME: Layout-only coordination context for the Speech feature shell.
// ABOUTME: Authoritative Speech service records live in TanStack Query, not this context.
import { createContext, useContext } from "react";

export type SpeechContextValue = {
  /** Layout shell token so future list coordination can share context without prop drilling. */
  ready: true;
};

export const SpeechContext = createContext<SpeechContextValue | null>(null);

/** Access Speech layout context; throws when used outside SpeechLayout. */
export function useSpeechContext(): SpeechContextValue {
  const value = useContext(SpeechContext);
  if (!value) {
    throw new Error("useSpeechContext must be used within SpeechLayout");
  }
  return value;
}
