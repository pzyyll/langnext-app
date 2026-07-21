// ABOUTME: Layout-only coordination context for the OCR feature shell.
// ABOUTME: Authoritative OCR service records live in TanStack Query, not this context.
import { createContext, useContext } from "react";

export type OcrContextValue = {
  /** Layout shell token so future list coordination can share context without prop drilling. */
  ready: true;
};

export const OcrContext = createContext<OcrContextValue | null>(null);

/** Access OCR layout context; throws when used outside OcrLayout. */
export function useOcrContext(): OcrContextValue {
  const value = useContext(OcrContext);
  if (!value) {
    throw new Error("useOcrContext must be used within OcrLayout");
  }
  return value;
}
