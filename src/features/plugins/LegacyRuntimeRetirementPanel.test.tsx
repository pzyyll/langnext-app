// ABOUTME: Retirement panel tests prove remediation actions, delete confirmation, and errors.
// ABOUTME: Uses Happy DOM + Testing Library; mocks the Tauri IPC boundary, not the client module.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import type { LegacyRuntimeInventoryEntryDto, LegacyRuntimeUnresolvedRowDto } from "../../storage/types";

const invokeMock = mock(async (cmd: string, args?: unknown): Promise<unknown> => {
  void cmd;
  void args;
  throw new Error("invoke not stubbed");
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class Channel {},
  Resource: class Resource {},
  transformCallback: () => "",
  convertFileSrc: (path: string) => path,
  isTauri: () => false,
  IS_TAURI: false,
}));

mock.module("~icons/material-symbols-light/check", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/check-circle", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/error", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/warning", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/info", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/close", () => ({ default: () => null }));

const { LegacyRuntimeRetirementPanel } = await import("./LegacyRuntimeRetirementPanel");
const { ToastProvider } = await import("../../components/toast/ToastProvider");

function row(overrides: Partial<LegacyRuntimeUnresolvedRowDto> = {}): LegacyRuntimeUnresolvedRowDto {
  return {
    subjectKind: "integration_instance",
    subjectId: "row-1",
    adapterId: null,
    displayName: "Google Web row",
    enabled: true,
    dependencyCount: 0,
    updateToken: "token-1",
    replacementPackageDigest: null,
    migrateAvailable: false,
    disableAvailable: true,
    deleteAvailable: true,
    ...overrides,
  };
}

function entry(rows: LegacyRuntimeUnresolvedRowDto[], overrides: Partial<LegacyRuntimeInventoryEntryDto> = {}) {
  return {
    executorId: "com.langnext.google-translate-web",
    runtimeKind: "bundled-rust",
    enabledLegacyRowCount: rows.filter((item) => item.enabled).length,
    disabledLegacyRowCount: rows.filter((item) => !item.enabled).length,
    dependentRowCount: rows.reduce((sum, item) => sum + item.dependencyCount, 0),
    replacementInstalledCount: 1,
    defaultPackageDigest: "a".repeat(64),
    defaultAuthorizationStatus: "authorized",
    packageFirstCreateReady: true,
    pendingActivationCount: 0,
    unavailableActivationCount: 0,
    legacyCreateStillPossible: false,
    blockerCodes: [],
    retirementReady: false,
    unresolvedRows: rows,
    ...overrides,
  };
}

const INTEGRATION_DIGEST = "a".repeat(64);

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LegacyRuntimeRetirementPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("LegacyRuntimeRetirementPanel", () => {
  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    resetDom();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => {
      throw new Error("invoke not stubbed for this test");
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders enabled, disabled, migratable, and dependency-blocked rows with correct actions", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_legacy_runtime_inventory") {
        const migratable = row({
          subjectId: "migrate-row",
          displayName: "Migratable web",
          migrateAvailable: true,
          replacementPackageDigest: INTEGRATION_DIGEST,
        });
        const enabled = row({ subjectId: "enabled-row", displayName: "Enabled web" });
        const disabled = row({
          subjectId: "disabled-row",
          displayName: "Disabled web",
          enabled: false,
          disableAvailable: false,
        });
        const blocked = row({
          subjectId: "blocked-row",
          displayName: "Blocked web",
          dependencyCount: 2,
          deleteAvailable: false,
        });
        return { entries: [entry([migratable, enabled, disabled, blocked])] };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    expect(await screen.findByText("Migratable web")).toBeTruthy();
    const migrateButtons = screen.getAllByRole("button", { name: "Migrate" });
    expect(migrateButtons).toHaveLength(4);
    expect(migrateButtons[0]).not.toBeDisabled();
    const disableButtons = screen.getAllByRole("button", { name: "Disable" });
    expect(disableButtons).toHaveLength(4);
    expect(disableButtons[0]).not.toBeDisabled();
    expect(disableButtons[2]).toBeDisabled();
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    expect(deleteButtons).toHaveLength(4);
    expect(deleteButtons[0]).not.toBeDisabled();
    expect(deleteButtons[3]).toBeDisabled();
    expect(deleteButtons[3].getAttribute("title")).toContain("2");
    expect(screen.getByText(/2 dependents/)).toBeTruthy();
  });

  test("disable calls the integration enable client with false", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { id: string; enabled?: boolean }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return { entries: [entry([row({ subjectId: "web-1", displayName: "Web row" })])] };
      }
      if (cmd === "set_integration_instance_enabled") {
        expect(args?.id).toBe("web-1");
        expect(args?.enabled).toBe(false);
        return { id: "web-1" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const disable = (await screen.findByRole("button", { name: "Disable" })) as HTMLButtonElement;
    await userEvent.click(disable);
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "set_integration_instance_enabled")).toBe(true);
    });
  });

  test("provider disable routes to set_provider_enabled", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { id: string; enabled?: boolean }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return {
          entries: [
            entry(
              [
                row({
                  subjectKind: "provider_binding",
                  subjectId: "provider-1",
                  adapterId: "openai-compatible",
                  displayName: "Provider row",
                }),
              ],
              { executorId: "legacy-frontend-provider" },
            ),
          ],
        };
      }
      if (cmd === "set_provider_enabled") {
        expect(args?.id).toBe("provider-1");
        expect(args?.enabled).toBe(false);
        return { id: "provider-1" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const disable = (await screen.findByRole("button", { name: "Disable" })) as HTMLButtonElement;
    await userEvent.click(disable);
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "set_provider_enabled")).toBe(true);
    });
  });

  test("delete requires explicit AlertDialog confirmation before any client call", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { id: string }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return { entries: [entry([row({ subjectId: "delete-row", displayName: "Delete web" })])] };
      }
      if (cmd === "delete_integration_instance") {
        expect(args?.id).toBe("delete-row");
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const deleteButton = (await screen.findByRole("button", { name: "Delete" })) as HTMLButtonElement;
    await userEvent.click(deleteButton);

    // The confirm dialog is open; no deletion happened yet.
    expect(await screen.findByText("Delete legacy configuration?")).toBeTruthy();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "delete_integration_instance")).toBe(false);

    // Cancel keeps the row.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "delete_integration_instance")).toBe(false);

    // Confirm deletes exactly once.
    await userEvent.click(deleteButton);
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    await waitFor(() => {
      const deleteCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_integration_instance");
      expect(deleteCalls).toHaveLength(1);
    });
  });

  test("integration migrate runs the upgrade preview/apply seam with the replacement digest", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { instanceId?: string; targetPackageDigest?: string }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return {
          entries: [
            entry([
              row({
                subjectId: "migrate-row",
                displayName: "Migratable web",
                migrateAvailable: true,
                replacementPackageDigest: INTEGRATION_DIGEST,
              }),
            ]),
          ],
        };
      }
      if (cmd === "preview_integration_runtime_upgrade") {
        expect(args?.instanceId).toBe("migrate-row");
        expect(args?.targetPackageDigest).toBe(INTEGRATION_DIGEST);
        return { previewId: "upgrade-preview", requiresPermissionApproval: true };
      }
      if (cmd === "apply_integration_runtime_upgrade") {
        const input = args as { input?: { previewId: string; acknowledgePermissions?: boolean } };
        expect(input.input?.previewId).toBe("upgrade-preview");
        expect(input.input?.acknowledgePermissions).toBe(true);
        return { result: "applied" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const migrateButton = (await screen.findByRole("button", { name: "Migrate" })) as HTMLButtonElement;
    await userEvent.click(migrateButton);
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "apply_integration_runtime_upgrade")).toBe(true);
    });
  });

  test("provider migrate routes through the interface attach seam", async () => {
    invokeMock.mockImplementation(
      async (cmd: string, args?: { input?: { providerId?: string; adapterId?: string; previewId?: string } }) => {
        if (cmd === "list_legacy_runtime_inventory") {
          return {
            entries: [
              entry(
                [
                  row({
                    subjectKind: "provider_binding",
                    subjectId: "provider-1",
                    adapterId: "anthropic",
                    displayName: "Provider row",
                    migrateAvailable: true,
                    replacementPackageDigest: INTEGRATION_DIGEST,
                  }),
                ],
                { executorId: "legacy-frontend-provider" },
              ),
            ],
          };
        }
        if (cmd === "preview_provider_runtime_interface_attach") {
          expect(args?.input?.providerId).toBe("provider-1");
          expect(args?.input?.adapterId).toBe("anthropic");
          expect(args?.input?.packageDigest).toBe(INTEGRATION_DIGEST);
          return { previewId: "attach-preview", requiresPermissionApproval: false };
        }
        if (cmd === "apply_provider_runtime_interface_attach") {
          expect(args?.input?.previewId).toBe("attach-preview");
          expect(args?.input?.acknowledgePermissions).toBe(false);
          return { result: "attached" };
        }
        throw new Error(`unexpected command ${cmd}`);
      },
    );

    renderPanel();

    const migrateButton = (await screen.findByRole("button", { name: "Migrate" })) as HTMLButtonElement;
    await userEvent.click(migrateButton);
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "apply_provider_runtime_interface_attach")).toBe(true);
    });
  });

  test("failed action keeps the row visible and shows the sanitized error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return { entries: [entry([row({ subjectId: "fail-row", displayName: "Failing web" })])] };
      }
      if (cmd === "set_integration_instance_enabled") {
        const error = new Error("set_integration_instance_enabled denied") as Error & { code?: string };
        error.code = "ipc_error";
        throw error;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const disable = (await screen.findByRole("button", { name: "Disable" })) as HTMLButtonElement;
    await userEvent.click(disable);
    const matches = await screen.findAllByText(/set_integration_instance_enabled denied/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Failing web")).toBeTruthy();
  });

  test("migrate is unavailable without an authorized replacement digest", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return {
          entries: [
            entry([row({ subjectId: "no-replacement", displayName: "No replacement", migrateAvailable: false })]),
          ],
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const migrateButton = (await screen.findByRole("button", { name: "Migrate" })) as HTMLButtonElement;
    expect(migrateButton).toBeDisabled();
    expect(migrateButton.getAttribute("title")).toBe("No authorized replacement package");
    expect(screen.getByText("No replacement")).toBeTruthy();
  });
  test("provider delete routes through the retirement-safe command with row authority", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { input?: Record<string, string> }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return {
          entries: [
            entry(
              [
                row({
                  subjectKind: "provider_binding",
                  subjectId: "provider-1",
                  adapterId: "openai-compatible",
                  displayName: "Provider row",
                  updateToken: "binding-token-1",
                }),
              ],
              { executorId: "legacy-frontend-provider:openai-compatible" },
            ),
          ],
        };
      }
      if (cmd === "delete_retired_legacy_provider") {
        expect(args?.input).toEqual({
          providerId: "provider-1",
          adapterId: "openai-compatible",
          updateToken: "binding-token-1",
        });
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const deleteButton = (await screen.findByRole("button", { name: "Delete" })) as HTMLButtonElement;
    await userEvent.click(deleteButton);
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "delete_retired_legacy_provider")).toBe(true);
    });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "delete_provider_instance")).toBe(false);
  });

  test("migrate uses the row replacement digest, never the entry-wide digest", async () => {
    const ROW_DIGEST = "d".repeat(64);
    invokeMock.mockImplementation(async (cmd: string, args?: { targetPackageDigest?: string }) => {
      if (cmd === "list_legacy_runtime_inventory") {
        return {
          entries: [
            entry(
              [
                row({
                  subjectId: "migrate-row",
                  displayName: "Row digest web",
                  migrateAvailable: true,
                  replacementPackageDigest: ROW_DIGEST,
                }),
              ],
              // Entry digest differs from the row digest; migration must use the row value.
              { defaultPackageDigest: "e".repeat(64) },
            ),
          ],
        };
      }
      if (cmd === "preview_integration_runtime_upgrade") {
        expect(args?.targetPackageDigest).toBe(ROW_DIGEST);
        return { previewId: "row-preview", requiresPermissionApproval: false };
      }
      if (cmd === "apply_integration_runtime_upgrade") {
        return { result: "applied" };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    renderPanel();

    const migrateButton = (await screen.findByRole("button", { name: "Migrate" })) as HTMLButtonElement;
    await userEvent.click(migrateButton);
    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "apply_integration_runtime_upgrade")).toBe(true);
    });
  });
});
