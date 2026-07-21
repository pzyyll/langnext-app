// ABOUTME: Raw Tauri window-chrome invokes for the quick-translate popup.
// ABOUTME: Pin/ready/height stay outside invokeEffect/IpcError by design.
import { invoke } from "@tauri-apps/api/core";

/** True when running inside a Tauri webview (not plain browser). */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Toggle always-on-top for the quick-translate window. */
export function setPin(isPin: boolean): Promise<void> {
  return invoke("set_pin", { isPin });
}

/** Signal backend that the frontend is ready for clipboard inject. */
export function notifyReady(): Promise<void> {
  return invoke("notify_ready");
}

/** Resize the quick-translate window height to content. */
export function resizeWindowHeight(height: number): Promise<void> {
  return invoke("resize_window_height", { height });
}
