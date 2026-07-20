// ABOUTME: Fullscreen region-screenshot selection UI for the secondary overlay window.
// ABOUTME: Loads backdrop from a temp file, reveals only after paint, drag-selects, copies via Rust.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { REGION_SCREENSHOT_SESSION_READY } from "../query/events";
import {
  regionScreenshotCancel,
  regionScreenshotConfirm,
  regionScreenshotGetBackdrop,
  regionScreenshotReveal,
} from "../storage/client";
import type { RegionScreenshotBackdrop } from "../storage/types";

export const Route = createFileRoute("/screenshot-overlay")({
  component: ScreenshotOverlayPage,
});

const MIN_SELECTION_CSS_PX = 4;
const DIM_OVERLAY_CLASS = "bg-black/45";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

function normalizeRect(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function backdropAssetUrl(path: string): string {
  // Cache-bust so a reused warm window always reloads the latest capture.
  const src = convertFileSrc(path);
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}t=${Date.now()}`;
}

function ScreenshotOverlayPage() {
  const { t } = useTranslation();
  const [backdropUrl, setBackdropUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragOrigin, setDragOrigin] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const finishingRef = useRef(false);
  const loadTokenRef = useRef(0);

  const applyBackdrop = useCallback(async (backdrop: RegionScreenshotBackdrop) => {
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    finishingRef.current = false;
    setBusy(false);
    setDragOrigin(null);
    setDragCurrent(null);
    setLoadError(null);
    setReady(false);
    setBackdropUrl(backdropAssetUrl(backdrop.path));
  }, []);

  // Cold start / reload: if a session is already active, pull the backdrop path.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const backdrop = await regionScreenshotGetBackdrop();
        if (!cancelled) {
          await applyBackdrop(backdrop);
        }
      } catch {
        // No active session yet — wait for session-ready event.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBackdrop]);

  // Warm window reuse: each new capture emits session-ready with a fresh path.
  // After the listener is attached, re-fetch once to cover the race where emit
  // fired before the webview finished registering handlers.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void (async () => {
      try {
        unlisten = await listen<RegionScreenshotBackdrop>(REGION_SCREENSHOT_SESSION_READY, (event) => {
          void applyBackdrop(event.payload);
        });
        if (cancelled) {
          return;
        }
        try {
          const backdrop = await regionScreenshotGetBackdrop();
          if (!cancelled) {
            await applyBackdrop(backdrop);
          }
        } catch {
          // Idle warm window — no session yet.
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : t("screenshot.loadFailed"));
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyBackdrop, t]);

  const onBackdropLoad = useCallback(() => {
    if (finishingRef.current) {
      return;
    }
    setReady(true);
    void (async () => {
      try {
        await regionScreenshotReveal();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("screenshot.loadFailed"));
      }
    })();
  }, [t]);

  const onBackdropError = useCallback(() => {
    setLoadError(t("screenshot.loadFailed"));
  }, [t]);

  const cancel = useCallback(async () => {
    if (finishingRef.current) {
      return;
    }
    finishingRef.current = true;
    setBusy(true);
    try {
      await regionScreenshotCancel();
      setBackdropUrl(null);
      setReady(false);
    } catch (err) {
      finishingRef.current = false;
      setBusy(false);
      setLoadError(err instanceof Error ? err.message : t("screenshot.cancelFailed"));
    }
  }, [t]);

  const confirm = useCallback(
    async (rect: Rect) => {
      if (finishingRef.current || busy || !ready) {
        return;
      }
      if (rect.width < MIN_SELECTION_CSS_PX || rect.height < MIN_SELECTION_CSS_PX) {
        setDragOrigin(null);
        setDragCurrent(null);
        return;
      }

      finishingRef.current = true;
      setBusy(true);
      try {
        const result = await regionScreenshotConfirm({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        if (!result.copiedToClipboard) {
          finishingRef.current = false;
          setBusy(false);
          setDragOrigin(null);
          setDragCurrent(null);
          setLoadError(t("screenshot.clipboardFailed"));
          return;
        }
        setBackdropUrl(null);
        setReady(false);
      } catch (err) {
        finishingRef.current = false;
        setBusy(false);
        setDragOrigin(null);
        setDragCurrent(null);
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(
          /clipboard/i.test(message) ? t("screenshot.clipboardFailed") : message || t("screenshot.confirmFailed"),
        );
      }
    },
    [busy, ready, t],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [cancel]);

  const selection = dragOrigin && dragCurrent ? normalizeRect(dragOrigin, dragCurrent) : null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || !ready || !backdropUrl || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    setDragOrigin(point);
    setDragCurrent(point);
    setLoadError(null);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOrigin || busy) {
      return;
    }
    setDragCurrent({ x: event.clientX, y: event.clientY });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOrigin || busy) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const rect = normalizeRect(dragOrigin, { x: event.clientX, y: event.clientY });
    setDragOrigin(null);
    setDragCurrent(null);
    void confirm(rect);
  };

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden bg-black"
      style={{ cursor: busy || !ready ? "progress" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
      role="application"
      aria-label={t("screenshot.ariaLabel")}
    >
      {backdropUrl ? (
        <img
          src={backdropUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full max-w-none object-fill"
          onLoad={onBackdropLoad}
          onError={onBackdropError}
        />
      ) : null}

      {/* Dim mask: four panels around the selection, or full dim when idle. */}
      {selection ? (
        <>
          <div
            className={`pointer-events-none absolute top-0 left-0 ${DIM_OVERLAY_CLASS}`}
            style={{ width: "100%", height: selection.y }}
          />
          <div
            className={`pointer-events-none absolute left-0 ${DIM_OVERLAY_CLASS}`}
            style={{
              top: selection.y,
              width: selection.x,
              height: selection.height,
            }}
          />
          <div
            className={`pointer-events-none absolute ${DIM_OVERLAY_CLASS}`}
            style={{
              top: selection.y,
              left: selection.x + selection.width,
              width: Math.max(0, window.innerWidth - selection.x - selection.width),
              height: selection.height,
            }}
          />
          <div
            className={`pointer-events-none absolute bottom-0 left-0 ${DIM_OVERLAY_CLASS}`}
            style={{
              top: selection.y + selection.height,
              width: "100%",
              height: Math.max(0, window.innerHeight - selection.y - selection.height),
            }}
          />
          <div
            className="pointer-events-none absolute border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.width,
              height: selection.height,
            }}
          />
          <div
            className="pointer-events-none absolute rounded-sm bg-black/70 px-2 py-0.5 text-xs text-white tabular-nums"
            style={{
              left: selection.x,
              top: Math.max(0, selection.y - 24),
            }}
          >
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </div>
        </>
      ) : ready ? (
        <div className={`pointer-events-none absolute inset-0 ${DIM_OVERLAY_CLASS}`} />
      ) : null}

      {ready ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <p className="rounded-sm bg-black/70 px-3 py-1 text-xs text-white">{t("screenshot.hint")}</p>
        </div>
      ) : null}

      {loadError ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
          <p className="max-w-md rounded-sm bg-error px-3 py-1 text-xs text-on-error" role="alert">
            {loadError}
          </p>
        </div>
      ) : null}
    </div>
  );
}
