// ABOUTME: Install dialog tests prove public approval cannot request a default mutation.
// ABOUTME: Uses Happy DOM + Testing Library; mocks package flow runners at the boundary.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import type { ApprovePluginPackageInput, PluginPackagePreviewDto } from "../../storage/types";

const previewRunnerMock = mock(async (): Promise<PluginPackagePreviewDto | null> => {
  throw new Error("preview runner not stubbed");
});
const approveRunnerMock = mock(async (input: ApprovePluginPackageInput) => {
  void input;
  throw new Error("approve runner not stubbed");
});
const discardRunnerMock = mock(async (previewId: string) => {
  void previewId;
});

mock.module("./installPluginPackageFlow", () => ({
  runSelectAndPreviewPluginPackage: () => previewRunnerMock(),
  runApprovePluginPackage: (input: ApprovePluginPackageInput) => approveRunnerMock(input),
  runDiscardPluginPackagePreview: (previewId: string) => discardRunnerMock(previewId),
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

const PACKAGE_DIGEST = "a".repeat(64);

function previewDto(overrides: Partial<PluginPackagePreviewDto> = {}): PluginPackagePreviewDto {
  return {
    previewId: "preview-install-1",
    packageDigest: PACKAGE_DIGEST,
    pluginId: "com.example.translate",
    version: "1.0.0",
    publisherKeyId: "com.example.keys.1",
    publisherFingerprint: "b".repeat(64),
    publisherTrust: "trusted_user",
    requiresPublisherApproval: false,
    runtimeKind: "wasm-component",
    capabilities: ["translate.text@1"],
    configurationSchema: null,
    network: [],
    authPolicies: [],
    permissionRequestDigest: "c".repeat(64),
    permissionDifferences: [],
    warnings: [],
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
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
    approveRunnerMock.mockReset();
    discardRunnerMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  test("completing install never sends setAsDefault and has no default control", async () => {
    const user = userEvent.setup();
    previewRunnerMock.mockResolvedValueOnce(previewDto());
    approveRunnerMock.mockResolvedValueOnce({
      version: {
        packageDigest: PACKAGE_DIGEST,
        pluginId: "com.example.translate",
        version: "1.0.0",
        publisherKeyId: "com.example.keys.1",
        publisherFingerprint: "b".repeat(64),
        runtimeKind: "wasm-component",
        permissionRequestDigest: "c".repeat(64),
        contentAvailable: true,
        isDefault: false,
        inUse: false,
        installedAt: "2099-01-01T00:00:00Z",
        capabilities: [],
        defaultAuthorizationStatus: "absent",
      },
      approvalId: "approval-1",
      approvalRevision: 1,
    });

    renderDialog();

    await user.click(await screen.findByRole("button", { name: "Choose package" }));
    await screen.findByText(PACKAGE_DIGEST);

    expect(screen.queryByText("Set as default for new configurations (existing configs stay pinned)")).toBeNull();
    expect(screen.queryByLabelText(/set as default/i)).toBeNull();

    await user.click(
      screen.getByRole("checkbox", {
        name: "I acknowledge the requested permissions. This approval is for installation only.",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Install package" }));

    await waitFor(() => {
      expect(approveRunnerMock).toHaveBeenCalledTimes(1);
    });
    const input = approveRunnerMock.mock.calls[0]?.[0] as ApprovePluginPackageInput;
    expect(input).toEqual({
      previewId: "preview-install-1",
      acknowledgePermissions: true,
      approvePublisher: false,
      publisherPublicKeyHex: null,
    });
    expect(Object.prototype.hasOwnProperty.call(input, "setAsDefault")).toBe(false);
  });
});
