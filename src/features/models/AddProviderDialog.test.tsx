// ABOUTME: Provider Add dialog treats catalog readiness separately from credential state.
// ABOUTME: Official catalog entries are selectable without a manual default step; catalog errors pre-submit.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import type { ProviderInstanceDto, ProviderRuntimeCatalogEntryDto } from "../../storage/types";

const actualStorageClient = await import("../../storage/client");

const listCatalogMock = mock(async (): Promise<ProviderRuntimeCatalogEntryDto[]> => {
  throw new Error("catalog runner not stubbed");
});
const saveProviderMock = mock(
  async (write: { adapterId: string; credential: { action: string } }): Promise<ProviderInstanceDto> => {
    void write;
    throw new Error("save runner not stubbed");
  },
);

mock.module("../../storage/client", () => ({
  ...actualStorageClient,
  listRuntimeProviderCatalog: () => listCatalogMock(),
  saveProviderInstance: (write: { adapterId: string; credential: { action: string } }) => saveProviderMock(write),
}));
mock.module("~icons/material-symbols-light/check", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/check-circle", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/error", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/warning", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/info", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/close", () => ({ default: () => null }));
mock.module("~icons/clarity/angle-line", () => ({ default: () => null }));

const { AddProviderDialog } = await import("./AddProviderDialog");
const { ToastProvider } = await import("../../components/toast/ToastProvider");

function officialCatalogEntry(): ProviderRuntimeCatalogEntryDto {
  return {
    pluginId: "com.langnext.provider.openai-compatible",
    version: "1.0.0",
    packageDigest: "a".repeat(64),
    publisher: { keyId: "com.langnext.vendor.keys.1", keyFingerprint: "b".repeat(64) },
    legacyAliases: ["openai-compatible"],
    capabilities: [
      { capabilityId: "llm.models.list@1", artifactPath: "artifacts/models-list.wasm", artifactDigest: "c".repeat(64) },
      { capabilityId: "llm.chat@1", artifactPath: "artifacts/chat.wasm", artifactDigest: "d".repeat(64) },
    ],
    detection: null,
  };
}

function providerInstance(): ProviderInstanceDto {
  return {
    id: "provider-1",
    adapterId: "openai-compatible",
    displayName: "OpenAI",
    baseUrl: "",
    baseUrlSource: "plugin_default",
    authScheme: { schemaVersion: 1, type: "bearer" },
    credentialKind: "api_key",
    hasCredential: false,
    enabled: true,
    proxyMode: "inherit",
    insecureHttpConfirmedAt: null,
    modelsSyncedAt: null,
    modelsSyncStatus: "not_synced",
    modelsSyncErrorCode: null,
    runtime: {
      adapterId: "openai-compatible",
      runtimeKind: "wasm-component",
      packageDigest: "a".repeat(64),
      state: "pending_activation",
      pluginVersion: "1.0.0",
      createdAt: "2026-08-24T00:00:00Z",
      updatedAt: "2026-08-24T00:00:00Z",
    },
    runtimeBindings: [],
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
  };
}

let createdProvider: ProviderInstanceDto | null = null;

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AddProviderDialog
            open={open}
            onOpenChange={setOpen}
            onCreated={(provider) => {
              createdProvider = provider;
            }}
          />
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return render(<Host />);
}

beforeAll(async () => {
  await initI18n();
});

afterEach(() => {
  cleanup();
  resetDom();
  listCatalogMock.mockReset();
  saveProviderMock.mockReset();
  createdProvider = null;
});

describe("AddProviderDialog catalog readiness", () => {
  test("official Provider catalog entries are selectable without a manual default-activation step", async () => {
    listCatalogMock.mockResolvedValue([officialCatalogEntry()]);
    const instance = providerInstance();
    saveProviderMock.mockResolvedValue(instance);

    renderDialog();
    // No manual "Make Default" / default-activation control exists in the create flow.
    expect(screen.queryByText(/make default/i)).toBeNull();
    expect(screen.queryByText(/makeDefault|authorize/i)).toBeNull();

    // Select the official adapter from the package catalog.
    const adapterTrigger = screen.getByRole("combobox", { name: /api type/i });
    await userEvent.click(adapterTrigger);
    const option = await screen.findByRole("option", { name: /openai-compatible/i });
    await userEvent.click(option);

    await userEvent.type(screen.getByLabelText(/display name/i), "OpenAI");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createdProvider).toEqual(instance));
    expect(saveProviderMock).toHaveBeenCalledTimes(1);
    const write = saveProviderMock.mock.calls[0]![0] as { adapterId: string; credential: { action: string } };
    expect(write.adapterId).toBe("openai-compatible");
    // No token typed: the credential action is keep, never a replacement of a secret.
    expect(write.credential.action).toBe("keep");
  });

  test("provider catalog readiness error is presented before submission", async () => {
    listCatalogMock.mockRejectedValue(new Error("provider catalog readiness failure"));
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("provider catalog readiness failure");
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("aria-disabled", "true");
    expect(saveProviderMock).not.toHaveBeenCalled();
  });

  test("empty official provider catalog is shown as readiness instead of a silent empty form", async () => {
    listCatalogMock.mockResolvedValue([]);
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no official provider packages/i);
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("aria-disabled", "true");
    expect(saveProviderMock).not.toHaveBeenCalled();
  });
});
