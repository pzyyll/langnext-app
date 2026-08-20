// ABOUTME: Production readiness-gating contract for IntegrationEditor Validate control.
// ABOUTME: Exercises the shared isIntegrationValidateDisabled helper used by the editor.
import { describe, expect, test } from "bun:test";
import {
  RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE,
  isIntegrationValidateDisabled,
} from "./defaultPackageActivationPresentation";

const SHA256_HEX_LEN = 64;

describe("IntegrationEditor Validate readiness gating", () => {
  const readyBase = {
    pending: false,
    dirty: false,
    pluginMissing: false,
    packageDigest: "a".repeat(SHA256_HEX_LEN),
  };

  test("disables Validate while pending activation", () => {
    expect(
      isIntegrationValidateDisabled({
        ...readyBase,
        runtimeState: "pending_activation",
      }),
    ).toBe(true);
  });

  test("disables Validate while authority confirmation is required", () => {
    expect(
      isIntegrationValidateDisabled({
        ...readyBase,
        runtimeState: "pending_activation",
        runtimeErrorCode: RUNTIME_AUTHORITY_CONFIRMATION_REQUIRED_CODE,
      }),
    ).toBe(true);
  });

  test("disables Validate while runtime is unavailable", () => {
    expect(
      isIntegrationValidateDisabled({
        ...readyBase,
        runtimeState: "unavailable",
        runtimeErrorCode: "package_verification_failed",
      }),
    ).toBe(true);
  });

  test("enables Validate for active runtime when no other blocker exists", () => {
    expect(
      isIntegrationValidateDisabled({
        ...readyBase,
        runtimeState: "active",
      }),
    ).toBe(false);
  });

  test("keeps ordinary dirty/pending blockers independent of activation readiness", () => {
    expect(isIntegrationValidateDisabled({ ...readyBase, runtimeState: "active", dirty: true })).toBe(true);
    expect(isIntegrationValidateDisabled({ ...readyBase, runtimeState: "active", pending: true })).toBe(true);
  });
});
