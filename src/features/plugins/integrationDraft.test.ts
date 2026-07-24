// ABOUTME: Unit tests for integration draft conversion and credential update helpers.
// ABOUTME: Ensures DTO→draft never echoes secrets and keep/replace/clear map correctly.
import { describe, expect, test } from "bun:test";
import type { IntegrationInstanceDto } from "../../storage/types";
import { GOOGLE_CLOUD_PLUGIN_ID, GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT } from "../../storage/types";
import {
  buildGoogleCloudWrite,
  draftFromIntegrationDto,
  emptyGoogleCloudDraft,
  hasRemoteRelevantMutation,
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

  test("hasRemoteRelevantMutation detects credential or Google Cloud config mutation, never name-only", () => {
    // Credential replace with value.
    const replace = draftFromIntegrationDto(sampleDto());
    replace.serviceAccountAction = "replace";
    replace.serviceAccountJson = '{"client_email":"a@b.com"}';
    expect(hasRemoteRelevantMutation(replace, sampleDto())).toBe(true);

    // replace with no value is a no-op keep.
    const replaceEmpty = draftFromIntegrationDto(sampleDto());
    replaceEmpty.serviceAccountAction = "replace";
    replaceEmpty.serviceAccountJson = "   ";
    expect(hasRemoteRelevantMutation(replaceEmpty, sampleDto())).toBe(false);

    // clear only mutates when a credential was previously stored.
    const clearExisting = draftFromIntegrationDto(sampleDto());
    clearExisting.serviceAccountAction = "clear";
    expect(hasRemoteRelevantMutation(clearExisting, sampleDto())).toBe(true);

    const missingDto = sampleDto({
      credentialSlots: [{ slotId: GOOGLE_CLOUD_SERVICE_ACCOUNT_SLOT, hasCredential: false, credentialRevision: 0 }],
    });
    const clearMissing = draftFromIntegrationDto(missingDto);
    clearMissing.serviceAccountAction = "clear";
    expect(hasRemoteRelevantMutation(clearMissing, missingDto)).toBe(false);

    // Google Cloud config mutation (projectId/location/proxyMode).
    const projectId = draftFromIntegrationDto(sampleDto());
    projectId.projectId = "other-project";
    expect(hasRemoteRelevantMutation(projectId, sampleDto())).toBe(true);

    const location = draftFromIntegrationDto(sampleDto());
    location.location = "us-central1";
    expect(hasRemoteRelevantMutation(location, sampleDto())).toBe(true);

    const proxyMode = draftFromIntegrationDto(sampleDto());
    proxyMode.proxyMode = "direct";
    expect(hasRemoteRelevantMutation(proxyMode, sampleDto())).toBe(true);

    // Name-only change does not need a remote re-check.
    const nameOnly = draftFromIntegrationDto(sampleDto());
    nameOnly.displayName = "Renamed";
    expect(hasRemoteRelevantMutation(nameOnly, sampleDto())).toBe(false);

    // Clean draft has no mutation.
    const clean = draftFromIntegrationDto(sampleDto());
    expect(hasRemoteRelevantMutation(clean, sampleDto())).toBe(false);
  });

  test("buildGoogleCloudWrite clear does not include secret text", () => {
    const draft = draftFromIntegrationDto(sampleDto());
    draft.serviceAccountAction = "clear";
    draft.serviceAccountJson = "should-not-send";
    const write = buildGoogleCloudWrite(draft, { id: draft.expectedUpdatedAt ? sampleDto().id : null });
    expect(write.credentials?.[0]?.credential).toEqual({ action: "clear" });
  });
});
