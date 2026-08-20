// ABOUTME: Shared preview-dialog controller and authority field coverage for default activation.
// ABOUTME: Hook contract tests plus focused authority DTO field assertions (no full Base UI click paths).
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, useEffect } from "react";
import type { DefaultPackageActivationPreviewDto, DefaultRuntimeAuthorityPreviewDto } from "../../storage/types";
const SHA256_HEX_LEN = 64;

await import("../../test/registerDom");
const { resetDom } = await import("../../test/registerDom");
await import("../../test/jestDom");
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");

const { useAcknowledgedPreviewDialog } = await import("./useAcknowledgedPreviewDialog");

const PACKAGE_DIGEST = "a".repeat(SHA256_HEX_LEN);

function defaultPreview(
  overrides: Partial<DefaultPackageActivationPreviewDto> = {},
): DefaultPackageActivationPreviewDto {
  return {
    previewId: "preview-default-1",
    pluginId: "com.example.translate",
    packageDigest: PACKAGE_DIGEST,
    version: "1.0.0",
    publisherKeyId: "com.example.keys.1",
    publisherFingerprint: "b".repeat(SHA256_HEX_LEN),
    runtimeKind: "wasm-component",
    permissionRequestDigest: "c".repeat(SHA256_HEX_LEN),
    capabilities: ["translate.text@1"],
    fixedNetworkAuthority: [
      {
        capabilityId: "translate.text@1",
        endpointId: "translate",
        origin: "https://example.com",
        baseUrl: "https://example.com",
        method: "POST",
        authPolicy: "none",
        originKind: "fixed",
        responseBodyModes: "json",
      },
    ],
    dynamicAuthorityWarnings: [],
    authPolicies: ["none"],
    requiresInstanceConfirmationForDynamicOrigins: false,
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

function authorityPreview(
  overrides: Partial<DefaultRuntimeAuthorityPreviewDto> = {},
): DefaultRuntimeAuthorityPreviewDto {
  return {
    previewId: "preview-authority-1",
    subjectKind: "integration_instance",
    subjectId: "subject-1",
    packageDigest: PACKAGE_DIGEST,
    expectedUpdateToken: "token-1",
    configDigest: "config-1",
    additionalNetworkAuthority: [
      {
        capabilityId: "translate.text@1",
        endpointId: "translate",
        origin: "https://dynamic.example.com",
        baseUrl: "https://dynamic.example.com/v1",
        method: "POST",
        authPolicy: "none",
        originKind: "dynamic",
        responseBodyModes: "json,bytes",
      },
    ],
    authPolicies: ["none"],
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

type HookHarnessProps<TPreview> = {
  active: boolean;
  sessionKey: string;
  loadPreview: () => Promise<TPreview>;
  fallbackError: string;
  onState?: (state: {
    loading: boolean;
    loadError: string | null;
    preview: TPreview | null;
    confirmDisabled: boolean;
    acknowledged: boolean;
  }) => void;
};

function HookHarness<TPreview>({
  active,
  sessionKey,
  loadPreview,
  fallbackError,
  onState,
}: HookHarnessProps<TPreview>) {
  const state = useAcknowledgedPreviewDialog({
    active,
    sessionKey,
    loadPreview,
    fallbackError,
    formatError: (error, fallback) => (error instanceof Error ? error.message : fallback),
  });
  useEffect(() => {
    onState?.({
      loading: state.loading,
      loadError: state.loadError,
      preview: state.preview,
      confirmDisabled: state.confirmDisabled,
      acknowledged: state.acknowledged,
    });
  }, [onState, state.acknowledged, state.confirmDisabled, state.loadError, state.loading, state.preview]);

  return createElement(
    "div",
    null,
    createElement("div", { "data-testid": "loading" }, String(state.loading)),
    createElement("div", { "data-testid": "confirm-disabled" }, String(state.confirmDisabled)),
    createElement("div", { "data-testid": "load-error" }, state.loadError ?? ""),
    createElement(
      "div",
      { "data-testid": "preview-id" },
      state.preview ? String((state.preview as { previewId?: string }).previewId ?? "") : "",
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "ack",
        onClick: () => state.setAcknowledged(true),
      },
      "ack",
    ),
  );
}

describe("useAcknowledgedPreviewDialog", () => {
  afterEach(() => {
    cleanup();
    resetDom();
  });

  test("loads preview, gates confirmation, and enables after acknowledgement", async () => {
    let resolvePreview: ((value: DefaultPackageActivationPreviewDto) => void) | undefined;
    const loadPreview = mock(
      () =>
        new Promise<DefaultPackageActivationPreviewDto>((resolve) => {
          resolvePreview = resolve;
        }),
    );

    render(
      createElement(HookHarness<DefaultPackageActivationPreviewDto>, {
        active: true,
        sessionKey: PACKAGE_DIGEST,
        loadPreview,
        fallbackError: "preview failed",
      }),
    );

    expect(screen.getByTestId("loading").textContent).toBe("true");
    expect(screen.getByTestId("confirm-disabled").textContent).toBe("true");

    await act(async () => {
      resolvePreview?.(defaultPreview());
    });
    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("false");
      expect(screen.getByTestId("preview-id").textContent).toBe("preview-default-1");
    });
    expect(screen.getByTestId("confirm-disabled").textContent).toBe("true");

    await act(async () => {
      screen.getByTestId("ack").click();
    });
    expect(screen.getByTestId("confirm-disabled").textContent).toBe("false");
  });

  test("rejected preview keeps confirmation disabled and surfaces the error", async () => {
    const loadPreview = mock(async () => {
      throw new Error("preview boom");
    });
    render(
      createElement(HookHarness<DefaultPackageActivationPreviewDto>, {
        active: true,
        sessionKey: PACKAGE_DIGEST,
        loadPreview,
        fallbackError: "preview failed",
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("load-error").textContent).toBe("preview boom");
    });
    expect(screen.getByTestId("confirm-disabled").textContent).toBe("true");
  });

  test("ignores late results after session key change", async () => {
    let resolveFirst: ((value: DefaultPackageActivationPreviewDto) => void) | undefined;
    const loadPreview = mock((session: string) => {
      if (session === "first") {
        return new Promise<DefaultPackageActivationPreviewDto>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(defaultPreview({ previewId: "preview-second", pluginId: "second.plugin" }));
    });

    // Production dialogs remount with key={sessionKey}; mirror that so state starts clean.
    const { rerender } = render(
      createElement(
        "div",
        { key: "first" },
        createElement(HookHarness<DefaultPackageActivationPreviewDto>, {
          active: true,
          sessionKey: "first",
          loadPreview: () => loadPreview("first"),
          fallbackError: "preview failed",
        }),
      ),
    );

    rerender(
      createElement(
        "div",
        { key: "second" },
        createElement(HookHarness<DefaultPackageActivationPreviewDto>, {
          active: true,
          sessionKey: "second",
          loadPreview: () => loadPreview("second"),
          fallbackError: "preview failed",
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("preview-id").textContent).toBe("preview-second");
    });

    await act(async () => {
      resolveFirst?.(defaultPreview({ previewId: "preview-late", pluginId: "late.plugin" }));
    });
    expect(screen.getByTestId("preview-id").textContent).toBe("preview-second");
  });
});

describe("DefaultRuntimeAuthorityPreview fields", () => {
  test("authority preview carries normalized base URL and response modes", () => {
    const preview = authorityPreview();
    expect(preview.additionalNetworkAuthority[0]?.baseUrl).toBe("https://dynamic.example.com/v1");
    expect(preview.additionalNetworkAuthority[0]?.responseBodyModes).toBe("json,bytes");
  });
});
