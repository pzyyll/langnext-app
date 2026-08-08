// ABOUTME: Rendered-dialog tests for configuration import preview accessibility and apply.
// ABOUTME: Uses Happy DOM + Testing Library; mocks the transfer Promise façades at the boundary.
// DOM setup must finish before any module captures the browser globals: bun test evaluates
// sibling static imports concurrently, so a static import order cannot guarantee that
// @testing-library/dom binds `screen` to a live Happy DOM document. This focused module
// registers its own environment with sequenced top-level awaits and then imports the
// rendering utilities dynamically. There is no global bunfig [test] preload.
await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { initI18n } from "../../i18n";
import { IpcError } from "../../storage/ipcError";
import type { ImportPreview, ImportResult } from "../../storage/types";

const applyRunnerMock = mock<(previewId: string) => Promise<unknown>>(async () => {
  throw new Error("apply runner not stubbed");
});
const prepareRunnerMock = mock<() => Promise<unknown>>(async () => {
  throw new Error("prepare runner not stubbed");
});

mock.module("./configurationTransfer", () => ({
  runApplyPreparedConfigurationImport: (previewId: string) => applyRunnerMock(previewId),
  runPrepareConfigurationImportFromFile: () => prepareRunnerMock(),
}));

// unplugin-icons aliases are Vite-only; the dialog imports the close icon via the
// `~icons/...` specifier that Bun cannot resolve, so stub it at the module boundary.
mock.module("~icons/material-symbols-light/close", () => ({
  default: () => null,
}));

const { ConfigurationImportPreviewDialog } = await import("./ConfigurationImportPreviewDialog");

function validPreview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    valid: true,
    counts: {},
    validationErrors: [],
    requiresAuthentication: [],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
    previewId: "cfgimp_test-1",
    runtimeRequirements: [],
    ...overrides,
  };
}

function appliedResult(): ImportResult {
  return { preview: validPreview(), applied: true };
}

/** Stateful host mirroring the route: the route owns the open flag and spies close calls. */
function renderDialog() {
  const onApplied = mock(() => {});
  const onOpenChange = mock(() => {});
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <ConfigurationImportPreviewDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onApplied={onApplied}
      />
    );
  }
  render(<Host />);
  return { onApplied, onOpenChange };
}

/** Run through Choose file → prepared preview so the Apply control is visible. */
async function reachPreviewed(user: ReturnType<typeof userEvent.setup>) {
  prepareRunnerMock.mockResolvedValueOnce({ status: "prepared", preview: validPreview() });
  await user.click(await screen.findByRole("button", { name: "Choose file…" }));
  await screen.findByRole("button", { name: "Apply import" });
}

describe("ConfigurationImportPreviewDialog apply flow", () => {
  beforeAll(async () => {
    await initI18n("en");
  });

  beforeEach(() => {
    applyRunnerMock.mockReset();
    applyRunnerMock.mockImplementation(async () => {
      throw new Error("apply runner not stubbed");
    });
    prepareRunnerMock.mockReset();
    prepareRunnerMock.mockImplementation(async () => {
      throw new Error("prepare runner not stubbed");
    });
  });

  afterEach(() => {
    cleanup();
    resetDom();
    applyRunnerMock.mockReset();
    prepareRunnerMock.mockReset();
  });

  test("double-click Apply starts exactly one import while the apply Promise is deferred", async () => {
    const user = userEvent.setup();
    const { onApplied } = renderDialog();
    await reachPreviewed(user);

    // Defer the apply Promise so the double click lands while IPC is in flight.
    let resolveApply!: (value: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveApply = resolve;
    });
    applyRunnerMock.mockReturnValueOnce(deferred);

    await user.dblClick(screen.getByRole("button", { name: "Apply import" }));

    // One IPC start, one visible Applying phase, no duplicate request.
    expect(applyRunnerMock).toHaveBeenCalledTimes(1);
    expect(applyRunnerMock).toHaveBeenCalledWith("cfgimp_test-1");
    expect(await screen.findByText("Applying…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply import" })).not.toBeInTheDocument();

    // Resolve the deferred apply; the completed host operation still reports applied once.
    await act(async () => {
      resolveApply({ status: "applied", result: appliedResult() });
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledWith(appliedResult());
  });

  test("non-conflict apply rejection renders the mapped error and Re-preview", async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachPreviewed(user);

    applyRunnerMock.mockRejectedValueOnce(
      new IpcError({ code: "validation_failed", message: "host rejected the apply" }),
    );

    await user.click(screen.getByRole("button", { name: "Apply import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("host rejected the apply");
    expect(screen.getByRole("button", { name: "Re-preview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    // The failure must not be treated as a completed apply.
    expect(applyRunnerMock).toHaveBeenCalledTimes(1);
  });

  test("closing the dialog mid-apply still runs the route workflow on success", async () => {
    const user = userEvent.setup();
    const { onApplied, onOpenChange } = renderDialog();
    await reachPreviewed(user);

    let resolveApply!: (value: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveApply = resolve;
    });
    applyRunnerMock.mockReturnValueOnce(deferred);

    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByText("Applying…")).toBeVisible();

    // Close while the host operation is still in flight. Closing must not pretend to
    // cancel the started host operation.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Applying…")).not.toBeInTheDocument();

    // The completed apply still runs the route acceptance workflow exactly once.
    await act(async () => {
      resolveApply({ status: "applied", result: appliedResult() });
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledWith(appliedResult());
  });

  test("conflict-mode radiogroup is named by its legend", async () => {
    renderDialog();
    expect(screen.getByRole("radiogroup", { name: "Conflict mode" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /^Merge/ })).toBeVisible();
    expect(screen.getByRole("radio", { name: /^Copy/ })).toBeVisible();
  });

  /** The one persistent corner close control must exist, be visible, and stay enabled. */
  async function expectSingleEnabledClose() {
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    expect(closeButtons).toHaveLength(1);
    expect(closeButtons[0]).toBeVisible();
    expect(closeButtons[0]).toBeEnabled();
  }

  test("one persistent corner Close stays visible and enabled in every phase", async () => {
    const user = userEvent.setup();
    renderDialog();

    // idle
    await expectSingleEnabledClose();

    // loading: a deferred prepare keeps the dialog busy
    let resolvePrepare!: (value: unknown) => void;
    prepareRunnerMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrepare = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("Previewing…")).toBeVisible();
    await expectSingleEnabledClose();

    // previewed
    await act(async () => {
      resolvePrepare({ status: "prepared", preview: validPreview() });
    });
    await screen.findByRole("button", { name: "Apply import" });
    await expectSingleEnabledClose();

    // applying: a deferred apply keeps the host operation in flight; the corner close
    // must remain enabled (a modal touch-screen reader needs the escape affordance).
    let resolveApply!: (value: unknown) => void;
    applyRunnerMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveApply = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByText("Applying…")).toBeVisible();
    await expectSingleEnabledClose();

    // conflict
    await act(async () => {
      resolveApply({ status: "conflict", conflictKind: "stale", message: "stale" });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The configuration changed after preview. Re-preview before applying.",
    );
    await expectSingleEnabledClose();

    // error: re-preview, then reject apply with a non-conflict failure
    prepareRunnerMock.mockResolvedValueOnce({ status: "prepared", preview: validPreview() });
    await user.click(screen.getByRole("button", { name: "Re-preview" }));
    await screen.findByRole("button", { name: "Apply import" });
    applyRunnerMock.mockRejectedValueOnce(
      new IpcError({ code: "validation_failed", message: "host rejected the apply" }),
    );
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("host rejected the apply");
    await expectSingleEnabledClose();
  });

  /** Copy-mode preview built on the v8-mixed.json contract values. */
  function v8MixedPreview(): ImportPreview {
    return {
      valid: true,
      counts: {
        providersCreate: 1,
        providersUpdate: 0,
        providersCopy: 0,
        modelsCreate: 0,
        modelsUpdate: 0,
        modelsCopy: 0,
        profilesCreate: 0,
        profilesUpdate: 0,
        profilesCopy: 0,
        integrationsCreate: 2,
        integrationsUpdate: 0,
        integrationsCopy: 0,
      },
      validationErrors: [],
      requiresAuthentication: [],
      integrationRequiresAuthentication: [],
      proxyRequiresAuthentication: false,
      defaultProfileCleared: false,
      previewId: "cfgimp_test-v8mixed",
      runtimeRequirements: [
        {
          subjectKind: "provider",
          subjectId: "00000000-0000-7000-8000-000000000001",
          displayLabel: "OpenAI Compatible",
          adapterId: "openai-compatible",
          runtimeKind: "legacy-frontend-provider",
          localStatus: "legacy",
          requiredAction: "none",
        },
        {
          subjectKind: "provider",
          subjectId: "00000000-0000-7000-8000-000000000001",
          displayLabel: "OpenAI Compatible",
          adapterId: "openai-responses",
          runtimeKind: "wasm-component",
          pluginId: "com.langnext.provider.openai-responses",
          pluginVersion: "1.0.0",
          packageDigest: "abababababababababababababababababababababababababababababababab",
          publisherKeyId: "com.langnext.vendor.keys.1",
          publisherKeyFingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          localStatus: "installed",
          requiredAction: "activate_after_import",
        },
        {
          subjectKind: "integration",
          subjectId: "00000000-0000-7000-8000-000000000002",
          displayLabel: "Google Web",
          runtimeKind: "bundled-rust",
          pluginId: "com.langnext.google-translate-web",
          pluginVersion: "1.0.0",
          localStatus: "bundled",
          requiredAction: "none",
        },
        {
          subjectKind: "integration",
          subjectId: "00000000-0000-7000-8000-000000000003",
          displayLabel: "Conformance Wasm",
          runtimeKind: "wasm-component",
          pluginId: "com.langnext.conformance",
          pluginVersion: "1.0.0",
          packageDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          publisherKeyId: "com.langnext.vendor.keys.1",
          publisherKeyFingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          localStatus: "installed",
          requiredAction: "activate_after_import",
        },
      ],
    };
  }

  test("confirmation shows mode, graph counts, and full runtime identity values", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Select Copy mode, then complete a preview built on the v8-mixed contract.
    await user.click(screen.getByRole("radio", { name: /^Copy/ }));
    prepareRunnerMock.mockResolvedValueOnce({ status: "prepared", preview: v8MixedPreview() });
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("button", { name: "Apply import" });

    // Mode row and graph counts.
    expect(screen.getByText("Mode")).toBeVisible();
    expect(screen.getByText("Copy")).toBeVisible();
    expect(screen.getByText("Providers: 1 new")).toBeVisible();
    expect(screen.getByText("Integrations: 2 new")).toBeVisible();

    // Exact runtime identity labels and full untruncated values.
    expect(screen.getAllByText("Plugin ID").length).toBeGreaterThan(0);
    expect(screen.getByText("com.langnext.provider.openai-responses")).toBeVisible();
    expect(screen.getAllByText("com.langnext.google-translate-web").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("com.langnext.vendor.keys.1").length).toBeGreaterThan(0);
    expect(screen.getByText("abababababababababababababababababababababababababababababababab")).toBeVisible();
    expect(
      screen.getAllByText("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Activate after import").length).toBeGreaterThan(0);
    // The truncated prefix/suffix form must never appear.
    expect(screen.queryByText(/^abababababab…ababab$/)).not.toBeInTheDocument();
  });

  test("conflict and error outcomes share Cancel and Re-preview with phase-specific alerts", async () => {
    const user = userEvent.setup();
    const { onApplied } = renderDialog();

    // Conflict outcome: typed expired copy, retry actions, no route notification.
    await reachPreviewed(user);
    applyRunnerMock.mockResolvedValueOnce({
      status: "conflict",
      conflictKind: "expired",
      message: "n/a",
    });
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The preview expired. Re-preview before applying.");
    expect(screen.getByRole("button", { name: "Re-preview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(onApplied).not.toHaveBeenCalled();

    // Non-conflict error outcome: same retry actions, its own alert text.
    prepareRunnerMock.mockResolvedValueOnce({ status: "prepared", preview: validPreview() });
    await user.click(screen.getByRole("button", { name: "Re-preview" }));
    await screen.findByRole("button", { name: "Apply import" });
    applyRunnerMock.mockRejectedValueOnce(
      new IpcError({ code: "validation_failed", message: "host rejected the apply" }),
    );
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("host rejected the apply");
    expect(screen.getByRole("button", { name: "Re-preview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(onApplied).not.toHaveBeenCalled();
  });

  test("invalid preview renders every delivered validation error without an overflow summary", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Ten distinct errors: more than any former frontend truncation limit.
    const errors = Array.from({ length: 10 }, (_, index) => `Validation error ${index + 1}`);
    prepareRunnerMock.mockResolvedValueOnce({
      status: "invalid",
      preview: validPreview({ valid: false, validationErrors: errors }),
    });
    await user.click(screen.getByRole("button", { name: "Choose file…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Import file failed validation.");
    for (const error of errors) {
      expect(screen.getByText(error)).toBeVisible();
    }
    // The first, ninth, and final delivered errors are visible; no overflow summary.
    expect(screen.getByText("Validation error 1")).toBeVisible();
    expect(screen.getByText("Validation error 9")).toBeVisible();
    expect(screen.getByText("Validation error 10")).toBeVisible();
    expect(screen.queryByText(/more errors/i)).not.toBeInTheDocument();
  });

  test("credential warning lists only the proxy category for a proxy-only preview", async () => {
    const user = userEvent.setup();
    renderDialog();
    prepareRunnerMock.mockResolvedValueOnce({
      status: "prepared",
      preview: validPreview({
        requiresAuthentication: [],
        integrationRequiresAuthentication: [],
        ocrRequiresAuthentication: [],
        proxyRequiresAuthentication: true,
      }),
    });
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("button", { name: "Apply import" });

    // The generic lead-in plus exactly the proxy category; no unrelated claims.
    expect(screen.getByText("Re-enter credentials after import:")).toBeVisible();
    expect(screen.getByText("Proxy")).toBeVisible();
    expect(screen.queryByText("Channels")).not.toBeInTheDocument();
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
    expect(screen.queryByText("OCR services")).not.toBeInTheDocument();
  });

  test("credential warning lists every reported category exactly once", async () => {
    const user = userEvent.setup();
    renderDialog();
    prepareRunnerMock.mockResolvedValueOnce({
      status: "prepared",
      preview: validPreview({
        requiresAuthentication: ["p1"],
        integrationRequiresAuthentication: ["i1"],
        ocrRequiresAuthentication: ["o1"],
        proxyRequiresAuthentication: true,
      }),
    });
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByRole("button", { name: "Apply import" });

    expect(screen.getByText("Re-enter credentials after import:")).toBeVisible();
    expect(screen.getAllByText("Channels")).toHaveLength(1);
    expect(screen.getAllByText("Integrations")).toHaveLength(1);
    expect(screen.getAllByText("OCR services")).toHaveLength(1);
    expect(screen.getAllByText("Proxy")).toHaveLength(1);
  });
});
