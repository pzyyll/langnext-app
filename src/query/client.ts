// ABOUTME: Per-webview TanStack Query client with desktop-local IPC defaults.
// ABOUTME: Constructed at module scope so React Strict Mode does not allocate duplicates.
import { QueryClient } from "@tanstack/react-query";

/** Shared QueryClient for this webview; not shared across Tauri windows. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      // Local SQLite IPC must run even when navigator.onLine is false.
      networkMode: "always",
    },
    mutations: {
      retry: false,
    },
  },
});
