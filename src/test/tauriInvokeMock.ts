// ABOUTME: Shared Tauri core mock for frontend tests that need invoke.
// ABOUTME: Provides Channel/transformCallback stubs so mock.module does not break peers.
import { mock } from "bun:test";

export const invokeMock = mock<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => {
  throw new Error("invoke not stubbed");
});

/** Install a suite-safe mock of `@tauri-apps/api/core` for workflow IPC tests. */
export function installTauriInvokeMock(): void {
  mock.module("@tauri-apps/api/core", () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
    Channel: class Channel {
      onmessage: ((response: unknown) => void) | null = null;
      // no-op stub used only so peer modules can import Channel
      constructor(_onmessage?: (response: unknown) => void) {}
    },
    transformCallback: (_callback?: unknown, _once?: boolean) => 0,
    convertFileSrc: (filePath: string) => filePath,
    isTauri: () => false,
    addPluginListener: async () => ({ unregister: async () => undefined }),
    checkPermissions: async () => ({}),
    requestPermissions: async () => ({}),
    PluginListener: class PluginListener {},
    Resource: class Resource {},
    SERIALIZE_TO_IPC_FN: "__TAURI_TO_IPC_KEY__",
  }));
}

export function resetInvokeMock(): void {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => {
    throw new Error("invoke not stubbed");
  });
}
