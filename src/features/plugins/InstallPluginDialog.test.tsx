// ABOUTME: Install dialog tests prove user archives need one permission confirmation per digest.
// ABOUTME: Uses Happy DOM + Testing Library; mocks the catalog flow runners at the boundary.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import type { InstallUserPackageInput, UserPackagePreviewDto } from "../../storage/types";

const previewRunnerMock = mock(async (): Promise<UserPackagePreviewDto | null> => {
  throw new Error("preview runner not stubbed");
});
const installRunnerMock = mock(async (input: InstallUserPackageInput) => {
  void input;
  throw new Error("install runner not stubbed");
});
const discardRunnerMock = mock(async (previewId: string) => {
  void previewId;
});

mock.module("./installPluginPackageFlow", () => ({
  runSelectAndPreviewUserPluginPackage: () => previewRunnerMock(),
  runInstallUserPluginPackage: (input: InstallUserPackageInput) => installRunnerMock(input),
  runDiscardUserPluginPackagePreview: (previewId: string) => discardRunnerMock(previewId),
}));

mock.module("~icons/material-symbols-light/check", () => ({
  default: () => null,
}));
mock.module("~icons/material-symbols-light/check-circle", () => ({
  default: () => null,
}));
mock.module("~icons/material-symbols-light/error", () => ({
  default: () => null,
}));
mock.module("~icons/material-symbols-light/warning", () => ({
  default: () => null,
}));
mock.module("~icons/material-symbols-light/info", () => ({
  default: () => null,
}));
mock.module("~icons/material-symbols-light/close", () => ({
  default: () => null,
}));

const { InstallPluginDialog } = await import("./InstallPluginDialog");
const { ToastProvider } = await import("../../components/toast/ToastProvider");

const CONTENT_DIGEST = "a".repeat(64);

function previewDto(overrides: Partial<UserPackagePreviewDto> = {}): UserPackagePreviewDto {
  return {
    previewId: "preview-install-1",
    contentDigest: CONTENT_DIGEST,
    pluginId: "com.example.translate",
    version: "1.0.0",
    runtimeKind: "wasm-component",
    capabilities: ["translate.text@1"],
    configurationSchema: null,
    network: [],
    authPolicies: [],
    credentialSlots: [],
    fileCount: 3,
    totalBytes: 2048,
    permissionDifferences: [],
    warnings: ["user plugin content has no authenticated publisher identity"],
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

function installedEntry() {
  return {
    pluginId: "com.example.translate",
    version: "1.0.0",
    source: "user" as const,
    contentKind: "archive" as const,
    contentDigest: CONTENT_DIGEST,
    runtimeKind: "wasm-component",
    pluginApiVersion: "1.0",
    capabilities: ["translate.text@1"],
    configurationSchema: null,
    network: [],
    authPolicies: [],
    credentialSlots: [],
    fileCount: 3,
    totalBytes: 2048,
    isDefault: false,
    inUse: false,
    removable: true,
    reloadable: false,
  };
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <InstallPluginDialog open={open} onOpenChange={setOpen} />
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  render(<Host />);
}

describe("InstallPluginDialog", () => {
  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    resetDom();
    previewRunnerMock.mockReset();
    installRunnerMock.mockReset();
    discardRunnerMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  test("install confirms the exact content digest with one acknowledgement", async () => {
    const user = userEvent.setup();
    previewRunnerMock.mockResolvedValueOnce(previewDto());
    installRunnerMock.mockResolvedValueOnce({ entry: installedEntry() });

    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Choose archive" }));
    await screen.findByText(CONTENT_DIGEST);

    expect(screen.getAllByText(/no authenticated publisher identity/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Set as default/i)).toBeNull();

    const install = screen.getByRole("button", { name: "Install" });
    expect(install).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("checkbox", {
        name: "I reviewed the requested permissions for this exact content digest.",
      }),
    );
    expect(install).toHaveProperty("disabled", false);
    await user.click(install);

    await waitFor(() => {
      expect(installRunnerMock).toHaveBeenCalledTimes(1);
    });
    const input = installRunnerMock.mock.calls[0]?.[0] as InstallUserPackageInput;
    expect(input).toEqual({
      previewId: "preview-install-1",
      contentDigest: CONTENT_DIGEST,
      acknowledgePermissions: true,
    });
    expect(Object.prototype.hasOwnProperty.call(input, "setAsDefault")).toBe(false);
  });

  test("native user content is not installable", async () => {
    const user = userEvent.setup();
    previewRunnerMock.mockResolvedValueOnce(previewDto({ runtimeKind: "trusted-native-worker" }));
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Choose archive" }));
    await screen.findByText(CONTENT_DIGEST);
    await user.click(
      screen.getByRole("checkbox", {
        name: "I reviewed the requested permissions for this exact content digest.",
      }),
    );
    const install = screen.getByRole("button", { name: "Install" });
    expect(install).toHaveProperty("disabled", true);
    expect(installRunnerMock).not.toHaveBeenCalled();
  });

  test("permission changes and warnings are shown before install", async () => {
    const user = userEvent.setup();
    previewRunnerMock.mockResolvedValueOnce(
      previewDto({
        permissionDifferences: ["network endpoint proxy"],
        network: [{ id: "proxy", origins: [], methods: ["GET"] }],
        credentialSlots: ["api-key"],
      }),
    );
    renderDialog();
    await user.click(await screen.findByRole("button", { name: "Choose archive" }));
    await screen.findByText(CONTENT_DIGEST);
    expect(screen.getByText("network endpoint proxy")).toBeTruthy();
    expect(screen.getByText(/instance-configured origin/)).toBeTruthy();
    expect(screen.getByText(/api-key/)).toBeTruthy();
  });
});
