// ABOUTME: Unit tests for capability-health presentation states and sanitization.
// ABOUTME: Proves absent rows are not checked and degraded output contains only stable metadata.
import { describe, expect, test } from "bun:test";
import { presentCapabilityHealth, presentCapabilityHealthList } from "./capabilityHealthPresentation";

const rows = [
  {
    capabilityId: "translate.text@1",
    status: "degraded" as const,
    errorCode: "permission_denied",
    checkedAt: "2026-01-01T00:00:00Z",
  },
  {
    capabilityId: "ocr.image@1",
    status: "ready" as const,
    errorCode: null,
    checkedAt: "2026-01-02T00:00:00Z",
  },
];

describe("capability health presentation", () => {
  test("distinguishes absent, ready, and degraded rows", () => {
    expect(presentCapabilityHealth("speech.synthesize@1", rows)).toMatchObject({
      status: "not_checked",
      normalizedCode: null,
      checkedAt: null,
    });
    expect(presentCapabilityHealth("ocr.image@1", rows)).toMatchObject({
      status: "ready",
      normalizedCode: null,
      checkedAt: "2026-01-02T00:00:00Z",
    });
    expect(presentCapabilityHealth("translate.text@1", rows)).toMatchObject({
      status: "degraded",
      normalizedCode: "permission_denied",
      checkedAt: "2026-01-01T00:00:00Z",
    });
  });

  test("projects only declared capability metadata", () => {
    const result = presentCapabilityHealthList(["translate.text@1", "ocr.image@1"], rows);
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
