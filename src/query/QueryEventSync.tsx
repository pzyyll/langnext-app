// ABOUTME: Subscribes once per webview to Tauri data-change events.
// ABOUTME: Invalidates local Query prefixes so each window refetches SQLite data.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { logger } from "../logger";
import { createDebouncedInvalidator } from "./debouncedInvalidator";
import { DATA_CHANGE_EVENT_BINDINGS } from "./dataChangeEventBindings";
import { registerDataChangeListeners } from "./registerDataChangeListeners";

/** Coalesce bulk model-delete event storms into one invalidate per prefix. */
const INVALIDATE_DEBOUNCE_MS = 50;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Mount inside QueryClientProvider (outside RouterProvider) so every route and
 * future quick-translation window shares the same invalidation listeners.
 */
export function QueryEventSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const invalidator = createDebouncedInvalidator((queryKey) => {
      void queryClient.invalidateQueries({ queryKey });
    }, INVALIDATE_DEBOUNCE_MS);

    async function subscribe() {
      const result = await registerDataChangeListeners({
        listen: (event, handler) => listen(event, handler),
        isCancelled: () => cancelled,
        onError: (event, error) => {
          logger.error(`query_event_listen_failed event=${event}`, error);
        },
        events: DATA_CHANGE_EVENT_BINDINGS.map((binding) => ({
          name: binding.event,
          onEvent: () => {
            for (const queryKey of binding.invalidateKeys) {
              invalidator.schedule(queryKey);
            }
          },
        })),
      });

      if (cancelled) {
        return;
      }

      unlisteners.push(...result.unlisteners);

      // Close the gap between mount and listener readiness: any mutation that
      // emitted during subscribe setup is recovered by a one-shot invalidate.
      if (result.unlisteners.length > 0) {
        for (const binding of DATA_CHANGE_EVENT_BINDINGS) {
          for (const queryKey of binding.invalidateKeys) {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
      }
    }

    void subscribe();

    return () => {
      cancelled = true;
      invalidator.cancel();
      for (const unlisten of unlisteners) {
        unlisten();
      }
      unlisteners.length = 0;
    };
  }, [queryClient]);

  return null;
}
