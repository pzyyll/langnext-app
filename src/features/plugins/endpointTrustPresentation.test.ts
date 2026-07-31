// ABOUTME: Unit tests for endpoint-trust presentation and save-payload decisions.
// ABOUTME: Covers status, acknowledgement gating, expiry, cancellation, and candidate drift.
import { describe, expect, test } from "bun:test";
import type { EndpointTrustPreviewDto } from "../../storage/types";
import {
  buildEndpointTrustSavePayload,
  cancelEndpointTrustSave,
  deriveEndpointTrustStatus,
  isCustomEndpointCandidate,
  isEndpointTrustPreviewExpired,
  normalizeEndpointTrustBaseUrl,
  readEdgeTtsBaseUrl,
  requiresEndpointTrustPreview,
} from "./endpointTrustPresentation";

const OFFICIAL_URL = "https://tts.wangwangit.com";
const CUSTOM_URL = "https://custom.example";
const CUSTOM_URL_ALT = "https://other.example";

function preview(overrides: Partial<EndpointTrustPreviewDto> = {}): EndpointTrustPreviewDto {
  return {
    previewId: "ept_1",
    instanceId: "00000000-0000-7000-8000-000000000001",
    pluginId: "com.langnext.edge-tts",
    endpointAlias: "tts-api",
    origin: CUSTOM_URL,
    method: "POST",
    relativePath: "v1/audio/speech",
    expiresAt: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("endpointTrustPresentation", () => {
  test("official candidate needs no preview", () => {
    const view = { applicable: true, candidateBaseUrl: OFFICIAL_URL, officialBaseUrl: OFFICIAL_URL };
    expect(isCustomEndpointCandidate(view)).toBe(false);
    expect(requiresEndpointTrustPreview(view)).toBe(false);
  });

  test("empty candidate defaults to official", () => {
    const view = { applicable: true, candidateBaseUrl: "   ", officialBaseUrl: OFFICIAL_URL };
    expect(isCustomEndpointCandidate(view)).toBe(false);
    expect(requiresEndpointTrustPreview(view)).toBe(false);
  });

  test("custom candidate requires a preview", () => {
    const view = { applicable: true, candidateBaseUrl: CUSTOM_URL, officialBaseUrl: OFFICIAL_URL };
    expect(isCustomEndpointCandidate(view)).toBe(true);
    expect(requiresEndpointTrustPreview(view)).toBe(true);
  });

  test("official equivalent URL forms stay official while a path is custom", () => {
    expect(normalizeEndpointTrustBaseUrl(`${OFFICIAL_URL}/`)).toBe(OFFICIAL_URL);
    expect(normalizeEndpointTrustBaseUrl("https://TTS.WANGWANGIT.COM:443")).toBe(OFFICIAL_URL);
    expect(
      isCustomEndpointCandidate({
        applicable: true,
        candidateBaseUrl: `${OFFICIAL_URL}/`,
        officialBaseUrl: OFFICIAL_URL,
      }),
    ).toBe(false);
    expect(
      isCustomEndpointCandidate({
        applicable: true,
        candidateBaseUrl: `${OFFICIAL_URL}/api`,
        officialBaseUrl: OFFICIAL_URL,
      }),
    ).toBe(true);
  });

  test("non-Edge-TTS plugin is never a custom candidate", () => {
    const view = { applicable: false, candidateBaseUrl: CUSTOM_URL, officialBaseUrl: OFFICIAL_URL };
    expect(isCustomEndpointCandidate(view)).toBe(false);
    expect(requiresEndpointTrustPreview(view)).toBe(false);
  });

  test("deriveEndpointTrustStatus reports official for normalized equivalent candidate", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: true,
        candidateBaseUrl: `${OFFICIAL_URL}/`,
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: OFFICIAL_URL,
        persistedStatus: "official",
      }),
    ).toBe("official");
  });

  test("deriveEndpointTrustStatus reports official for default candidate", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: true,
        candidateBaseUrl: OFFICIAL_URL,
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: OFFICIAL_URL,
        persistedStatus: "official",
      }),
    ).toBe("official");
  });

  test("deriveEndpointTrustStatus reports review required for a changed custom candidate", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: true,
        candidateBaseUrl: CUSTOM_URL,
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: OFFICIAL_URL,
        persistedStatus: "official",
      }),
    ).toBe("review_required");
  });

  test("deriveEndpointTrustStatus reports trusted custom for unchanged approved candidate", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: true,
        candidateBaseUrl: CUSTOM_URL,
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: CUSTOM_URL,
        persistedStatus: "trusted_custom",
      }),
    ).toBe("trusted_custom");
  });

  test("deriveEndpointTrustStatus downgrades to review required when candidate drifts from trusted", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: true,
        candidateBaseUrl: CUSTOM_URL_ALT,
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: CUSTOM_URL,
        persistedStatus: "trusted_custom",
      }),
    ).toBe("review_required");
  });

  test("deriveEndpointTrustStatus is not applicable for other plugins", () => {
    expect(
      deriveEndpointTrustStatus({
        applicable: false,
        candidateBaseUrl: "",
        officialBaseUrl: OFFICIAL_URL,
        persistedBaseUrl: "",
        persistedStatus: "not_applicable",
      }),
    ).toBe("not_applicable");
  });

  test("buildEndpointTrustSavePayload gates on acknowledgement", () => {
    const result = buildEndpointTrustSavePayload({
      preview: preview(),
      acknowledged: false,
      candidateBaseUrlAtPreview: CUSTOM_URL,
      currentCandidateBaseUrl: CUSTOM_URL,
    });
    expect(result).toBeNull();
  });

  test("buildEndpointTrustSavePayload returns payload when acknowledged and candidate unchanged", () => {
    const result = buildEndpointTrustSavePayload({
      preview: preview(),
      acknowledged: true,
      candidateBaseUrlAtPreview: CUSTOM_URL,
      currentCandidateBaseUrl: CUSTOM_URL,
    });
    expect(result).toEqual({
      endpointTrustPreviewId: "ept_1",
      acknowledgeEndpointTrust: true,
    });
  });

  test("buildEndpointTrustSavePayload refuses a stale preview after the candidate changes", () => {
    const result = buildEndpointTrustSavePayload({
      preview: preview(),
      acknowledged: true,
      candidateBaseUrlAtPreview: CUSTOM_URL,
      currentCandidateBaseUrl: CUSTOM_URL_ALT,
    });
    expect(result).toBeNull();
  });

  test("buildEndpointTrustSavePayload refuses an expired preview", () => {
    const expired = preview({ expiresAt: "2000-01-01T00:00:00Z" });
    expect(isEndpointTrustPreviewExpired(expired)).toBe(true);
    const result = buildEndpointTrustSavePayload({
      preview: expired,
      acknowledged: true,
      candidateBaseUrlAtPreview: CUSTOM_URL,
      currentCandidateBaseUrl: CUSTOM_URL,
    });
    expect(result).toBeNull();
  });

  test("buildEndpointTrustSavePayload respects an injected clock", () => {
    const future = preview({ expiresAt: "2099-01-01T00:00:00Z" });
    const now = new Date("2099-06-01T00:00:00Z");
    expect(isEndpointTrustPreviewExpired(future, now)).toBe(true);
    expect(
      buildEndpointTrustSavePayload({
        preview: future,
        acknowledged: true,
        candidateBaseUrlAtPreview: CUSTOM_URL,
        currentCandidateBaseUrl: CUSTOM_URL,
        now,
      }),
    ).toBeNull();
  });

  test("isEndpointTrustPreviewExpired treats unparseable expiry as expired", () => {
    expect(isEndpointTrustPreviewExpired(preview({ expiresAt: "not-a-date" }))).toBe(true);
  });

  test("cancelEndpointTrustSave produces no payload", () => {
    expect(cancelEndpointTrustSave()).toBeNull();
  });

  test("readEdgeTtsBaseUrl reads the persisted base-url", () => {
    expect(readEdgeTtsBaseUrl('{"base-url":"https://custom.example"}')).toBe("https://custom.example");
    expect(readEdgeTtsBaseUrl("not json")).toBe("");
    expect(readEdgeTtsBaseUrl('{"other":1}')).toBe("");
    expect(readEdgeTtsBaseUrl("")).toBe("");
  });
});
