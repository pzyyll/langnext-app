// ABOUTME: Effective API-type display decisions shared by the model table and edit dialog.
// ABOUTME: Explicit override wins; discovered remote models show their source, never a generic default.
import { describe, expect, test } from "bun:test";
import { resolveInheritApiTypeLabelKey, resolveModelApiTypeDisplay } from "./modelApiTypeDisplay";

describe("resolveModelApiTypeDisplay", () => {
  test("an explicit API type override wins over the discovery source", () => {
    expect(resolveModelApiTypeDisplay({ adapterId: "openai-compatible", sourceAdapterId: "gemini" })).toEqual({
      kind: "override",
      adapterId: "openai-compatible",
    });
  });

  test("a discovered remote model without an override shows its source type", () => {
    expect(resolveModelApiTypeDisplay({ adapterId: null, sourceAdapterId: "gemini" })).toEqual({
      kind: "source",
      adapterId: "gemini",
    });
  });

  test("manual and builtin models without discovery provenance stay on inherit", () => {
    expect(resolveModelApiTypeDisplay({ adapterId: null, sourceAdapterId: null })).toEqual({ kind: "inherit" });
    expect(resolveModelApiTypeDisplay({ adapterId: "", sourceAdapterId: null })).toEqual({ kind: "inherit" });
  });
});

describe("resolveInheritApiTypeLabelKey", () => {
  test("models discovered through a source name that source instead of a generic default", () => {
    expect(resolveInheritApiTypeLabelKey("gemini")).toBe("models.apiTypeFromSource");
    expect(resolveInheritApiTypeLabelKey(null)).toBe("models.apiTypeInherit");
    expect(resolveInheritApiTypeLabelKey("")).toBe("models.apiTypeInherit");
  });
});
