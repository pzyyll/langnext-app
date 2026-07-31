// ABOUTME: Pure endpoint-trust status, save-payload, and acknowledgement decisions.
// ABOUTME: The UI never auto-acknowledges or submits a preview after the candidate changes.
import type { EndpointTrustPreviewDto, EndpointTrustStatus } from "../../storage/types";

export type { EndpointTrustPreviewDto, EndpointTrustStatus } from "../../storage/types";

/** Opaque acknowledged endpoint-trust fields appended to an integration save. */
export type EndpointTrustSavePayload = {
  readonly endpointTrustPreviewId: string;
  readonly acknowledgeEndpointTrust: true;
};

/** Candidate view for deciding whether a save needs an endpoint-trust preview. */
export type EndpointTrustCandidateView = {
  readonly applicable: boolean;
  readonly candidateBaseUrl: string;
  readonly officialBaseUrl: string;
};

/** Candidate view plus persisted state for the status label under the base URL field. */
export type EndpointTrustStatusView = EndpointTrustCandidateView & {
  readonly persistedBaseUrl: string;
  readonly persistedStatus: EndpointTrustStatus;
};

/** Normalize a candidate enough for display/scheduling equivalence; the host remains authoritative on save. */
export function normalizeEndpointTrustBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.hostname.length === 0
    ) {
      return null;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}`;
  } catch {
    return null;
  }
}

function isOfficialBaseUrl(candidate: string, official: string): boolean {
  const normalizedCandidate = normalizeEndpointTrustBaseUrl(candidate);
  const normalizedOfficial = normalizeEndpointTrustBaseUrl(official);
  return normalizedCandidate !== null && normalizedCandidate !== "" && normalizedCandidate === normalizedOfficial;
}

/** Read the persisted Edge TTS `base-url` from a normalized config JSON string. */
export function readEdgeTtsBaseUrl(configJson: string): string {
  if (!configJson) {
    return "";
  }
  try {
    const value = JSON.parse(configJson) as unknown;
    if (value && typeof value === "object") {
      const field = (value as Record<string, unknown>)["base-url"];
      if (typeof field === "string") {
        return field;
      }
    }
  } catch {
    // Ignore malformed config; the host re-normalizes on save.
  }
  return "";
}

/** True for an Edge TTS candidate whose complete base URL is not the default. */
export function isCustomEndpointCandidate(view: EndpointTrustCandidateView): boolean {
  if (!view.applicable) {
    return false;
  }
  const value = view.candidateBaseUrl.trim();
  if (value.length === 0) {
    return false;
  }
  return !isOfficialBaseUrl(value, view.officialBaseUrl);
}

/** A save must request a host preview + acknowledgement before persisting. */
export function requiresEndpointTrustPreview(view: EndpointTrustCandidateView): boolean {
  return isCustomEndpointCandidate(view);
}

/** Candidate trust status to display under the base URL field. */
export function deriveEndpointTrustStatus(view: EndpointTrustStatusView): EndpointTrustStatus {
  if (!view.applicable) {
    return "not_applicable";
  }
  const candidate = view.candidateBaseUrl.trim();
  if (candidate.length === 0 || isOfficialBaseUrl(candidate, view.officialBaseUrl)) {
    return "official";
  }
  const normalizedCandidate = normalizeEndpointTrustBaseUrl(candidate);
  const normalizedPersisted = normalizeEndpointTrustBaseUrl(view.persistedBaseUrl);
  if (
    normalizedCandidate !== null &&
    normalizedCandidate === normalizedPersisted &&
    view.persistedStatus === "trusted_custom"
  ) {
    return "trusted_custom";
  }
  return "review_required";
}

/** True when the host preview has reached its expiry. */
export function isEndpointTrustPreviewExpired(preview: EndpointTrustPreviewDto, now: Date = new Date()): boolean {
  const expiry = Date.parse(preview.expiresAt);
  if (Number.isNaN(expiry)) {
    return true;
  }
  return now.getTime() >= expiry;
}

export type EndpointTrustSavePayloadParams = {
  readonly preview: EndpointTrustPreviewDto;
  readonly acknowledged: boolean;
  /** Draft base URL captured when the preview was requested. */
  readonly candidateBaseUrlAtPreview: string;
  /** Draft base URL at confirm time; a change invalidates the preview. */
  readonly currentCandidateBaseUrl: string;
  readonly now?: Date;
};

/**
 * Build the opaque acknowledged save payload only when the user acknowledged AND
 * the candidate base URL has not drifted from the previewed candidate. The host
 * re-verifies origin/fingerprint/revision; this guard prevents submitting a
 * stale preview after the candidate changes. Returns null when not acknowledged,
 * when the candidate changed, or when the preview expired.
 */
export function buildEndpointTrustSavePayload(params: EndpointTrustSavePayloadParams): EndpointTrustSavePayload | null {
  if (!params.acknowledged) {
    return null;
  }
  const previewCandidate = normalizeEndpointTrustBaseUrl(params.candidateBaseUrlAtPreview);
  const currentCandidate = normalizeEndpointTrustBaseUrl(params.currentCandidateBaseUrl);
  if (previewCandidate === null || currentCandidate === null || previewCandidate !== currentCandidate) {
    return null;
  }
  if (!params.preview.previewId) {
    return null;
  }
  if (isEndpointTrustPreviewExpired(params.preview, params.now ?? new Date())) {
    return null;
  }
  return {
    endpointTrustPreviewId: params.preview.previewId,
    acknowledgeEndpointTrust: true,
  };
}

/** Cancel retains the unsaved draft and produces no trust payload. */
export function cancelEndpointTrustSave(): EndpointTrustSavePayload | null {
  return null;
}
