// ABOUTME: Catalog list tests prove source-specific actions: remove only for user content, reload
// ABOUTME: only for development content, and native content is never user-installable.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor, within } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import { installTauriInvokeMock, invokeMock, resetInvokeMock } from "../../test/tauriInvokeMock";
import type { PluginCatalogEntryDto, PluginCatalogSnapshotDto, PluginSource } from "../../storage/types";

installTauriInvokeMock();

mock.module("~icons/material-symbols-light/close", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/error", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/warning", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/info", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/check", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/check-circle", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/undo", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/delete", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/refresh", () => ({ default: () => null }));

const { InstalledPluginVersions } = await import("./InstalledPluginVersions");
const { ToastProvider } = await import("../../components/toast/ToastProvider");

const BUILT_IN_DIGEST = "1".repeat(64);
const DEVELOPMENT_DIGEST = "2".repeat(64);
const USER_DIGEST = "3".repeat(64);
const NATIVE_DIGEST = "4".repeat(64);

/** Recorded IPC calls per command name. */
const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

let snapshot: PluginCatalogSnapshotDto = { entries: [], errors: [] };

function installedEntry(source: PluginSource, overrides: Partial<PluginCatalogEntryDto> = {}): PluginCatalogEntryDto {
  return {
    pluginId: `com.example.${source}`,
    version: "1.0.0",
    source,
    contentKind: source === "user" ? "archive" : "directory",
    contentDigest: BUILT_IN_DIGEST,
    runtimeKind: "wasm-component",
    pluginApiVersion: "1.0",
    capabilities: ["translate.text@1"],
    configurationSchema: null,
    network: [],
    authPolicies: [],
    credentialSlots: [],
    fileCount: 2,
    totalBytes: 1024,
    isDefault: false,
    inUse: false,
    removable: false,
    reloadable: false,
    ...overrides,
  };
}

/** One catalog row per source, each with its source-appropriate action flags. */
function catalogSnapshot(): PluginCatalogSnapshotDto {
  return {
    entries: [
      installedEntry("built_in", {
        pluginId: "com.example.builtin",
        contentDigest: BUILT_IN_DIGEST,
        isDefault: true,
      }),
      installedEntry("development", {
        pluginId: "com.example.development",
        contentDigest: DEVELOPMENT_DIGEST,
        reloadable: true,
      }),
      installedEntry("user", { pluginId: "com.example.user", contentDigest: USER_DIGEST, removable: true }),
    ],
    errors: [],
  };
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <InstalledPluginVersions />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The list row that shows `pluginId`, scoped to its own list item. */
async function rowFor(pluginId: string) {
  const heading = await screen.findByText(new RegExp(`^${pluginId}@1\\.0\\.0$`));
  const listItem = heading.closest("li");
  if (!listItem) {
    throw new Error(`no list row for ${pluginId}`);
  }
  return within(listItem);
}

describe("InstalledPluginVersions", () => {
  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    resetDom();
    resetInvokeMock();
    calls.length = 0;
    snapshot = catalogSnapshot();
    invokeMock.mockImplementation(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_plugin_catalog" || cmd === "refresh_plugin_catalog") {
        return snapshot;
      }
      return undefined;
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("every source renders its own label without trust or signature wording", async () => {
    renderList();
    await rowFor("com.example.builtin");
    expect(screen.getByText("Built-in")).toBeTruthy();
    expect(screen.getByText("Development")).toBeTruthy();
    expect(screen.getByText("User")).toBeTruthy();
    // The unknown-publisher statement is the only publisher wording, and only for user content.
    expect(screen.getAllByText(/no authenticated publisher identity/).length).toBe(1);
    expect(screen.queryByText(/signature/i)).toBeNull();
  });

  test("remove exists only for user content", async () => {
    renderList();
    const user = await rowFor("com.example.user");
    expect(user.getByRole("button", { name: "Remove" })).toBeTruthy();
    for (const other of ["com.example.builtin", "com.example.development"]) {
      const row = await rowFor(other);
      expect(row.queryByRole("button", { name: "Remove" })).toBeNull();
    }
  });

  test("reload exists only for development content", async () => {
    renderList();
    const development = await rowFor("com.example.development");
    expect(development.getByRole("button", { name: "Reload" })).toBeTruthy();
    for (const other of ["com.example.builtin", "com.example.user"]) {
      const row = await rowFor(other);
      expect(row.queryByRole("button", { name: "Reload" })).toBeNull();
    }
  });

  test("removing a user archive sends its exact content digest", async () => {
    const user = userEvent.setup();
    renderList();
    const row = await rowFor("com.example.user");
    await user.click(row.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(calls).toContainEqual({ cmd: "remove_user_plugin_package", args: { contentDigest: USER_DIGEST } });
    });
  });

  test("the built-in default cannot be cleared but a user override can", async () => {
    snapshot = {
      entries: [
        installedEntry("built_in", {
          pluginId: "com.example.builtin",
          contentDigest: BUILT_IN_DIGEST,
          isDefault: true,
        }),
        installedEntry("user", {
          pluginId: "com.example.user",
          contentDigest: USER_DIGEST,
          removable: true,
          isDefault: true,
        }),
      ],
      errors: [],
    };
    const user = userEvent.setup();
    renderList();

    const builtin = await rowFor("com.example.builtin");
    expect(builtin.getByRole("button", { name: "Clear default" }).hasAttribute("disabled")).toBe(true);

    const userRow = await rowFor("com.example.user");
    await user.click(userRow.getByRole("button", { name: "Clear default" }));
    await waitFor(() => {
      expect(calls).toContainEqual({ cmd: "clear_plugin_catalog_default", args: { pluginId: "com.example.user" } });
    });
  });

  test("a non-default built-in can be given an explicit default override", async () => {
    snapshot = {
      entries: [installedEntry("built_in", { pluginId: "com.example.builtin", contentDigest: BUILT_IN_DIGEST })],
      errors: [],
    };
    const user = userEvent.setup();
    renderList();
    const row = await rowFor("com.example.builtin");
    await user.click(row.getByRole("button", { name: "Set default" }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        cmd: "set_plugin_catalog_default",
        args: { pluginId: "com.example.builtin", contentDigest: BUILT_IN_DIGEST },
      });
    });
  });

  test("native content is listed without a reload action and is never user-installable", async () => {
    snapshot = {
      entries: [
        installedEntry("user", {
          pluginId: "com.example.native",
          contentDigest: NATIVE_DIGEST,
          runtimeKind: "trusted-native-worker",
          removable: true,
        }),
      ],
      errors: [],
    };
    renderList();
    const row = await rowFor("com.example.native");
    expect(row.queryByRole("button", { name: "Reload" })).toBeNull();
    // Native content is never user-installable: the install path accepts Wasm archives only.
    const { isUserInstallableRuntime } = await import("./pluginPackagePresentation");
    expect(isUserInstallableRuntime("trusted-native-worker")).toBe(false);
    expect(isUserInstallableRuntime("wasm-component")).toBe(true);
  });

  test("catalog errors are reported without hiding valid entries", async () => {
    snapshot = {
      entries: [installedEntry("built_in", { pluginId: "com.example.builtin", contentDigest: BUILT_IN_DIGEST })],
      errors: [
        {
          code: "invalid_manifest",
          source: "user",
          pluginId: "com.example.broken",
          relativePath: "plugin.json",
          message: "unknown field",
        },
      ],
    };
    renderList();
    await rowFor("com.example.builtin");
    expect(await screen.findByText("invalid_manifest")).toBeTruthy();
    expect(screen.getByText("unknown field")).toBeTruthy();
  });
});
