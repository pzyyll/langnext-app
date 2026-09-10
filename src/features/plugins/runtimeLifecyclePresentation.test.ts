// ABOUTME: Unit tests for runtime lifecycle presentation helpers.
// ABOUTME: Covers unresolved pins, identity labels, and upgrade acknowledgement.
import { describe, expect, test } from "bun:test";
import {
  acknowledgePermissionsForApply,
  formatPermissionDifference,
  formatRuntimeIdentity,
  hasThirdPartyEgressChange,
  isRuntimeUnresolved,
  upgradeApprovalDetailsReady,
  upgradeRequiresAcknowledgement,
} from "./runtimeLifecyclePresentation";
import type { RuntimeUpgradePreviewDto } from "../../storage/types";

function basePreview(overrides: Partial<RuntimeUpgradePreviewDto> = {}): RuntimeUpgradePreviewDto {
  return {
    previewId: "rup_1",
    instanceId: "i",
    source: {
      runtimeKind: "wasm-component",
      packageDigest: "b".repeat(64),
      executionGrantSetRevision: 1,
      runtimeState: "active",
    },
    target: {
      runtimeKind: "wasm-component",
      packageDigest: "a".repeat(64),
      executionGrantSetRevision: 1,
      runtimeState: "active",
    },
    sourcePluginVersion: "1.0.0",
    targetPluginVersion: "1.1.0",
    requiresPermissionApproval: false,
    capabilityCompatibility: [],
    schemaMigrations: [],
    credentialSlots: [],
    permissionDifferences: [],
    expiresAt: "t",
    ...overrides,
  };
}

describe("runtimeLifecyclePresentation", () => {
  test("detects unresolved runtime pins", () => {
    expect(
      isRuntimeUnresolved({
        effectiveStatus: "ready",
        runtimeState: "unavailable",
        runtimeErrorCode: "plugin_missing",
      }),
    ).toBe(true);
    expect(
      isRuntimeUnresolved({
        effectiveStatus: "plugin_missing",
        runtimeState: "active",
        runtimeErrorCode: null,
      }),
    ).toBe(true);
    expect(
      isRuntimeUnresolved({
        effectiveStatus: "ready",
        runtimeState: "active",
        runtimeErrorCode: null,
      }),
    ).toBe(false);
  });

  test("formats package-backed identity with short digest", () => {
    const label = formatRuntimeIdentity({
      runtimeKind: "wasm-component",
      packageDigest: "abcdef0123456789" + "0".repeat(48),
      executionGrantSetRevision: 2,
      runtimeState: "active",
    });
    expect(label).toContain("wasm-component");
    expect(label).toContain("abcdef012345");
    expect(label).toContain("r2");
  });

  test("formats structured permission differences", () => {
    expect(
      formatPermissionDifference({
        kind: "network_endpoint_added",
        summary: "network slow added",
        resource: "slow",
        origin: "https://conformance.example",
        method: "GET",
        authPolicy: "host.none.v1",
      }),
    ).toContain("origin=https://conformance.example");
  });

  test("upgradeRequiresAcknowledgement tracks the permission flag", () => {
    const base = basePreview();
    expect(upgradeRequiresAcknowledgement(base)).toBe(false);
    expect(upgradeRequiresAcknowledgement({ ...base, requiresPermissionApproval: true })).toBe(true);
  });

  test("acknowledgePermissionsForApply never auto-signs expansions", () => {
    const base = basePreview();
    expect(acknowledgePermissionsForApply(base, true)).toBe(false);
    expect(
      acknowledgePermissionsForApply(
        {
          ...base,
          requiresPermissionApproval: true,
          permissionDifferences: [{ kind: "capability_added", summary: "cap" }],
        },
        false,
      ),
    ).toBe(false);
    expect(
      acknowledgePermissionsForApply(
        {
          ...base,
          requiresPermissionApproval: true,
          permissionDifferences: [{ kind: "capability_added", summary: "cap" }],
        },
        true,
      ),
    ).toBe(true);
    expect(
      upgradeApprovalDetailsReady({
        ...base,
        requiresPermissionApproval: true,
        permissionDifferences: [],
      }),
    ).toBe(false);
  });

  test("hasThirdPartyEgressChange flags non-GTX proxy origin additions only", () => {
    const gtx = basePreview({
      requiresPermissionApproval: true,
      permissionDifferences: [
        { kind: "network_endpoint_added", summary: "gtx", origin: "https://translate.google.com" },
      ],
    });
    expect(hasThirdPartyEgressChange(gtx)).toBe(false);

    const proxy = basePreview({
      requiresPermissionApproval: true,
      permissionDifferences: [{ kind: "network_endpoint_added", summary: "proxy", origin: "https://proxy-a.example" }],
    });
    expect(hasThirdPartyEgressChange(proxy)).toBe(true);

    const removedOnly = basePreview({
      requiresPermissionApproval: true,
      permissionDifferences: [
        { kind: "network_endpoint_removed", summary: "old proxy", origin: "https://proxy-a.example" },
      ],
    });
    expect(hasThirdPartyEgressChange(removedOnly)).toBe(false);
  });
});
