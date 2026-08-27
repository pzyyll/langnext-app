// ABOUTME: Built-in availability and credential state are separate in the Add dialog.
// ABOUTME: Authorized built-in definitions create unconfigured instances; catalog errors surface pre-submit.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "../../i18n";
import type { IntegrationInstanceDto, ServiceIntegrationDefinitionDto } from "../../storage/types";

const actualStorageClient = await import("../../storage/client");

type IntegrationWriteLike = { pluginId: string; configJson: string; credentials: unknown[] };
const listDefinitionsMock = mock(async (): Promise<ServiceIntegrationDefinitionDto[]> => {
  throw new Error("definitions runner not stubbed");
});
const saveInstanceMock = mock(async (write: IntegrationWriteLike): Promise<IntegrationInstanceDto> => {
  void write;
  throw new Error("save runner not stubbed");
});

mock.module("../../storage/client", () => ({
  ...actualStorageClient,
  listServiceIntegrationDefinitions: () => listDefinitionsMock(),
  saveIntegrationInstance: (write: IntegrationWriteLike) => saveInstanceMock(write),
}));
mock.module("~icons/material-symbols-light/check", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/check-circle", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/error", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/warning", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/info", () => ({ default: () => null }));
mock.module("~icons/material-symbols-light/close", () => ({ default: () => null }));

const { AddIntegrationDialog } = await import("./AddIntegrationDialog");
const { ToastProvider } = await import("../../components/toast/ToastProvider");

function baiduDefinition(): ServiceIntegrationDefinitionDto {
  return {
    manifestVersion: 1,
    pluginApiVersion: "1.0",
    id: "com.langnext.baidu-ocr",
    version: "1.0.0",
    displayNameKey: "plugins.com.langnext.baidu-ocr.name",
    minHostVersion: "0.1.0",
    configSchemaVersion: 1,
    credentialSlots: [
      { id: "api-key", kind: "secret_json", required: true },
      { id: "secret-key", kind: "secret_json", required: true },
    ],
    endpoints: [
      { alias: "baidu-general-basic", baseUrl: "https://aip.baidubce.com" },
      { alias: "baidu-accurate-basic", baseUrl: "https://aip.baidubce.com" },
      { alias: "baidu-general", baseUrl: "https://aip.baidubce.com" },
      { alias: "baidu-accurate", baseUrl: "https://aip.baidubce.com" },
    ],
    capabilities: [{ id: "ocr.image@1", preferencesSchemaVersion: 1, endpointAliases: [] }],
    configSchema: { version: 1, fields: [], groups: [] },
    capabilitySchemas: [],
    presentation: { displayNameFallback: "Baidu OCR" },
  };
}

function unconfiguredInstance(pluginId: string): IntegrationInstanceDto {
  return {
    id: "instance-baidu-1",
    pluginId,
    pluginVersion: "1.0.0",
    displayName: "Baidu OCR",
    enabled: true,
    configJson: "{}",
    configSchemaVersion: 1,
    healthStatus: "unconfigured",
    effectiveStatus: "unconfigured",
    endpointTrustStatus: "not_applicable",
    lastValidatedAt: null,
    lastErrorCode: null,
    runtimeKind: "wasm-component",
    packageDigest: "a".repeat(64),
    executionGrantSetRevision: null,
    runtimeState: "pending_activation",
    runtimeErrorCode: null,
    runtimeErrorMessage: null,
    runtimeRequirement: null,
    credentialSlots: [
      { slotId: "api-key", hasCredential: false, credentialRevision: 0 },
      { slotId: "secret-key", hasCredential: false, credentialRevision: 0 },
    ],
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
  };
}

let createdInstance: IntegrationInstanceDto | null = null;

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AddIntegrationDialog
            open={open}
            onOpenChange={setOpen}
            onCreated={(instance) => {
              createdInstance = instance;
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
  listDefinitionsMock.mockReset();
  saveInstanceMock.mockReset();
  createdInstance = null;
});

describe("AddIntegrationDialog built-in availability", () => {
  test("authorized built-in definition is selectable before credentials exist and creates an unconfigured instance", async () => {
    listDefinitionsMock.mockResolvedValue([baiduDefinition()]);
    const instance = unconfiguredInstance("com.langnext.baidu-ocr");
    saveInstanceMock.mockResolvedValue(instance);

    renderDialog();
    const button = await screen.findByRole("button", { name: "Baidu OCR" });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);

    await waitFor(() => expect(createdInstance).toEqual(instance));
    expect(saveInstanceMock).toHaveBeenCalledTimes(1);
    const write = saveInstanceMock.mock.calls[0]![0] as {
      pluginId: string;
      configJson: string;
      credentials: unknown[];
    };
    expect(write.pluginId).toBe("com.langnext.baidu-ocr");
    expect(write.configJson).toBe("{}");
    expect(write.credentials).toEqual([]);
    expect(instance.healthStatus).toBe("unconfigured");
    expect(instance.credentialSlots.every((slot) => !slot.hasCredential)).toBe(true);
  });

  test("missing credentials never hide the built-in definition", async () => {
    listDefinitionsMock.mockResolvedValue([baiduDefinition()]);
    renderDialog();
    const button = await screen.findByRole("button", { name: "Baidu OCR" });
    expect(button).not.toBeDisabled();
    expect(screen.queryByText(/no installed packages/i)).toBeNull();
  });

  test("definition catalog error is presented before submission, not as a generic create failure", async () => {
    listDefinitionsMock.mockRejectedValue(new Error("catalog readiness failure"));
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("catalog readiness failure");
    expect(screen.queryByRole("button", { name: "Baidu OCR" })).toBeNull();
    expect(saveInstanceMock).not.toHaveBeenCalled();
  });
});
