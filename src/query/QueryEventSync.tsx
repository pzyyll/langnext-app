// ABOUTME: Subscribes once per webview to Tauri data-change events.
// ABOUTME: Invalidates local Query prefixes so each window refetches SQLite data.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { logger } from "../logger";
import { createDebouncedInvalidator } from "./debouncedInvalidator";
import {
  DATA_MODELS_CHANGED,
  DATA_OCR_SERVICES_CHANGED,
  DATA_PROVIDERS_CHANGED,
  DATA_TRANSLATION_HISTORY_CHANGED,
  DATA_TRANSLATION_PROFILES_CHANGED,
} from "./events";
import { historyKeys, modelKeys, ocrKeys, profileKeys, providerKeys } from "./keys";
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
        events: [
          {
            name: DATA_TRANSLATION_PROFILES_CHANGED,
            onEvent: () => {
              invalidator.schedule(profileKeys.all);
            },
          },
          {
            name: DATA_PROVIDERS_CHANGED,
            onEvent: () => {
              // Provider enablement affects model availability in selectors.
              invalidator.schedule(providerKeys.all);
              invalidator.schedule(modelKeys.all);
            },
          },
          {
            name: DATA_MODELS_CHANGED,
            onEvent: () => {
              invalidator.schedule(modelKeys.all);
            },
          },
          {
            name: DATA_TRANSLATION_HISTORY_CHANGED,
            onEvent: () => {
              invalidator.schedule(historyKeys.all);
            },
          },
          {
            name: DATA_OCR_SERVICES_CHANGED,
            onEvent: () => {
              invalidator.schedule(ocrKeys.all);
            },
          },
        ],
      });

      if (cancelled) {
        return;
      }

      unlisteners.push(...result.unlisteners);

      // Close the gap between mount and listener readiness: any mutation that
      // emitted during subscribe setup is recovered by a one-shot invalidate.
      if (result.unlisteners.length > 0) {
        void queryClient.invalidateQueries({ queryKey: profileKeys.all });
        void queryClient.invalidateQueries({ queryKey: providerKeys.all });
        void queryClient.invalidateQueries({ queryKey: modelKeys.all });
        void queryClient.invalidateQueries({ queryKey: historyKeys.all });
        void queryClient.invalidateQueries({ queryKey: ocrKeys.all });
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
