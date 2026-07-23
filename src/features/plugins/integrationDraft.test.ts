// ABOUTME: Unit tests for integration draft conversion and credential update helpers.
// ABOUTME: Ensures DTO→draft never echoes secrets and keep/replace/clear map correctly.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto } from "../../storage/types";
import { GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT } from "../../storage/types";
import {
  buildGoogleCloudWrite,
  draftFromIntegrationDto,
  emptyGoogleCloudDraft,
  toCredentialUpdate,
} from "./integrationDraft";

function sampleDto(overrides?: Partial<IntegrationInstanceDto>): IntegrationInstanceDto {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    pluginId: GOOGLE_CLOUD_PLUGIN_ID,
    pluginVersion: "1.0.0",
    displayName: "GCP",
    enabled: true,
    configJson: JSON.stringify({
      projectId: "my-project",
      location: "global",
      proxyMode: "inherit",
    }),
    configSchemaVersion: 1,
    healthStatus: "unvalidated",
    effectiveStatus: "unvalidated",
    lastValidatedAt: null,
    lastErrorCode: null,
    credentialSlots: [
      {
        slotId: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT,
        hasCredential: true,
        credentialRevision: 2,
      },
    ],
    createdAt: "t0",
    updatedAt: "t1",
    ...overrides,
  };
}

describe("integrationDraft", () => {
  test("draftFromIntegrationDto never copies secrets and only reports stored state", () => {
    const dto = sampleDto();
    const draft = draftFromIntegrationDto(dto);
    expect(draft.serviceAccountJson).toBe("");
    expect(draft.serviceAccountAction).toBe("keep");
    expect(draft.hasServiceAccount).toBe(true);
    expect(draft.projectId).toBe("my-project");
    expect(draft.expectedUpdatedAt).toBe("t1");
    expect(JSON.stringify(draft)).not.toContain("private_key");
  });

  test("toCredentialUpdate maps keep replace clear", () => {
    expect(toCredentialUpdate("keep", "")).toEqual({ action: "keep" });
    expect(toCredentialUpdate("replace", "  secret  ")).toEqual({
      action: "replace",
      value: "secret",
    });
    expect(toCredentialUpdate("replace", "   ")).toEqual({ action: "keep" });
    expect(toCredentialUpdate("clear", "anything")).toEqual({ action: "clear" });
  });

  test("buildGoogleCloudWrite emits replace credential without echoing into config", () => {
    const draft = emptyGoogleCloudDraft("Cloud A");
    draft.projectId = "proj";
    draft.serviceAccountAction = "replace";
    draft.serviceAccountJson = '{"client_email":"a@b.com"}';
    const write = buildGoogleCloudWrite(draft);
    expect(write.pluginId).toBe(GOOGLE_CLOUD_PLUGIN_ID);
    expect(write.configJson).not.toContain("client_email");
    expect(write.credentials?.[0]?.slotId).toBe(GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT);
    expect(write.credentials?.[0]?.credential).toEqual({
      action: "replace",
      value: '{"client_email":"a@b.com"}',
    });
  });

  test("buildGoogleCloudWrite clear does not include secret text", () => {
    const draft = draftFromIntegrationDto(sampleDto());
    draft.serviceAccountAction = "clear";
    draft.serviceAccountJson = "should-not-send";
    const write = buildGoogleCloudWrite(draft, { id: draft.expectedUpdatedAt ? sampleDto().id : null });
    expect(write.credentials?.[0]?.credential).toEqual({ action: "clear" });
  });
});
