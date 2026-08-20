// ABOUTME: Presentation coverage for default package authorization and activation UX states.
// ABOUTME: Asserts pending/failure/confirmation mapping without manual digest in the normal flow.
import { describe, expect, test } from "bun:test";
import {
  canAuthorizeInstalledDefault,
  presentAdvancedRecoveryDigestVisibility,
  presentDefaultPackageAuthorizationStatus,
  presentDefaultRuntimeActivation,
  type DefaultPackageActivationTranslationKey,
} from "./defaultPackageActivationPresentation";

describe("DefaultPackageActivationTranslationKey", () => {
  test("accepts every key returned by presentation helpers", () => {
    const statusKeys = (["absent", "unauthorized", "authorized", "stale", "confirmation_required"] as const).flatMap(
      (status) => {
        const presentation = presentDefaultPackageAuthorizationStatus(status);
        return [presentation.labelKey, presentation.descriptionKey] as const;
      },
    );
    const runtimeKeys = [
      presentDefaultRuntimeActivation({
        runtimeState: "pending_activation",
        hasAuthorizedDefault: true,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "unavailable",
        runtimeErrorCode: "package_verification_failed",
        hasAuthorizedDefault: true,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "unavailable",
        hasAuthorizedDefault: false,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "active",
        hasAuthorizedDefault: true,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "idle",
        hasAuthorizedDefault: true,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "idle",
        hasAuthorizedDefault: false,
      }),
      presentDefaultRuntimeActivation({
        runtimeState: "pending_activation",
        hasAuthorizedDefault: true,
        authorityConfirmationRequired: true,
      }),
    ].flatMap((presentation) => [presentation.labelKey, presentation.descriptionKey] as const);

    const accepted: DefaultPackageActivationTranslationKey[] = [...statusKeys, ...runtimeKeys];
    expect(accepted.length).toBeGreaterThan(0);
    for (const key of accepted) {
      // Compile-time: every returned key is assignable to the closed union.
      const typed: DefaultPackageActivationTranslationKey = key;
      expect(typed.includes("defaultActivation")).toBe(true);
    }

    // @ts-expect-error invalid catalog path must not be assignable
    const invalid: DefaultPackageActivationTranslationKey = "plugins.packages.not.a.real.key";
    void invalid;
  });
});

describe("presentDefaultPackageAuthorizationStatus", () => {
  test("existing default without policy is unauthorized and not package-first ready", () => {
    const presentation = presentDefaultPackageAuthorizationStatus("unauthorized");
    expect(presentation.requiresAuthorization).toBe(true);
    expect(presentation.packageFirstReady).toBe(false);
    expect(presentation.tone).toBe("warning");
  });

  test("authorized default is package-first ready", () => {
    const presentation = presentDefaultPackageAuthorizationStatus("authorized");
    expect(presentation.requiresAuthorization).toBe(false);
    expect(presentation.packageFirstReady).toBe(true);
    expect(presentation.tone).toBe("success");
  });

  test("stale policy requires re-authorization", () => {
    const presentation = presentDefaultPackageAuthorizationStatus("stale");
    expect(presentation.requiresAuthorization).toBe(true);
    expect(presentation.packageFirstReady).toBe(false);
    expect(presentation.allowReauthorization).toBe(true);
  });

  test("current unauthorized/stale defaults may reauthorize", () => {
    expect(
      canAuthorizeInstalledDefault({
        isDefault: true,
        contentAvailable: true,
        defaultAuthorizationStatus: "unauthorized",
      }),
    ).toBe(true);
    expect(
      canAuthorizeInstalledDefault({
        isDefault: true,
        contentAvailable: true,
        defaultAuthorizationStatus: "stale",
      }),
    ).toBe(true);
    expect(
      canAuthorizeInstalledDefault({
        isDefault: true,
        contentAvailable: true,
        defaultAuthorizationStatus: "authorized",
      }),
    ).toBe(false);
    expect(
      canAuthorizeInstalledDefault({
        isDefault: true,
        contentAvailable: false,
        defaultAuthorizationStatus: "unauthorized",
      }),
    ).toBe(false);
  });
});

describe("presentAdvancedRecoveryDigestVisibility", () => {
  test("digest stays hidden while recovery is collapsed", () => {
    const presentation = presentAdvancedRecoveryDigestVisibility({
      hasUsableDefault: false,
      chooseAnotherPackage: false,
      panelOpen: false,
    });
    expect(presentation.showDigestInput).toBe(false);
  });

  test("no usable default shows digest only after expand", () => {
    const presentation = presentAdvancedRecoveryDigestVisibility({
      hasUsableDefault: false,
      chooseAnotherPackage: false,
      panelOpen: true,
    });
    expect(presentation.showDigestInput).toBe(true);
    expect(presentation.showChooseAnotherPackage).toBe(false);
  });

  test("usable default requires explicit choose-another-package", () => {
    expect(
      presentAdvancedRecoveryDigestVisibility({
        hasUsableDefault: true,
        chooseAnotherPackage: false,
        panelOpen: true,
      }).showDigestInput,
    ).toBe(false);
    expect(
      presentAdvancedRecoveryDigestVisibility({
        hasUsableDefault: true,
        chooseAnotherPackage: true,
        panelOpen: true,
      }).showDigestInput,
    ).toBe(true);
  });
});

describe("presentDefaultRuntimeActivation", () => {
  test("pending activation hides digest and disables ready actions", () => {
    const presentation = presentDefaultRuntimeActivation({
      runtimeState: "pending_activation",
      hasAuthorizedDefault: true,
    });
    expect(presentation.state).toBe("pending_activation");
    expect(presentation.hideManualDigest).toBe(true);
    expect(presentation.disableReadyActions).toBe(true);
    expect(presentation.showRetry).toBe(false);
    expect(presentation.labelKey).toContain("pending");
  });

  test("unavailable shows retry without requiring digest when a default exists", () => {
    const presentation = presentDefaultRuntimeActivation({
      runtimeState: "unavailable",
      runtimeErrorCode: "package_verification_failed",
      hasAuthorizedDefault: true,
    });
    expect(presentation.state).toBe("unavailable");
    expect(presentation.showRetry).toBe(true);
    expect(presentation.hideManualDigest).toBe(true);
    expect(presentation.disableReadyActions).toBe(true);
  });

  test("authority confirmation opens only the additional-authority path", () => {
    const presentation = presentDefaultRuntimeActivation({
      runtimeState: "pending_activation",
      hasAuthorizedDefault: true,
      authorityConfirmationRequired: true,
    });
    expect(presentation.state).toBe("confirmation_required");
    expect(presentation.showAuthorityConfirm).toBe(true);
    expect(presentation.hideManualDigest).toBe(true);
  });

  test("without usable default, advanced recovery may show digest entry", () => {
    const presentation = presentDefaultRuntimeActivation({
      runtimeState: "unavailable",
      hasAuthorizedDefault: false,
    });
    expect(presentation.hideManualDigest).toBe(false);
    expect(presentation.showRetry).toBe(true);
  });
});
