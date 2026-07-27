// ABOUTME: Tests localized fallback labels and closed plugin icon resolution.
// ABOUTME: Ensures unknown plugin metadata cannot select arbitrary visual assets.
import { describe, expect, test } from "bun:test";
import { resolveLocalizedText, resolvePluginDisplayName, resolvePluginIcon } from "./pluginPresentation";

const lookup = (key: string, options?: { defaultValue?: string }): string => {
  const translations: Record<string, string> = { "plugins.example.name": "Localized plugin" };
  return translations[key] ?? options?.defaultValue ?? key;
};

describe("pluginPresentation", () => {
  test("uses localization when it exists and a trusted fallback otherwise", () => {
    expect(resolveLocalizedText(lookup, "plugins.example.name", "Example plugin")).toBe("Localized plugin");
    expect(resolveLocalizedText(lookup, "plugins.missing.name", "Example plugin")).toBe("Example plugin");
    expect(resolveLocalizedText(lookup, undefined, "Example plugin")).toBe("Example plugin");
  });

  test("reads display metadata instead of plugin ID branches", () => {
    expect(
      resolvePluginDisplayName(
        {
          id: "com.example.plugin",
          displayNameKey: "plugins.missing.name",
          presentation: { displayNameFallback: "Example plugin" },
        },
        lookup,
      ),
    ).toBe("Example plugin");
  });

  test("uses one generic icon for unknown IDs", () => {
    expect(resolvePluginIcon("unknown-plugin-icon")).toBe(resolvePluginIcon(undefined));
    expect(resolvePluginIcon("edge-tts")).not.toBe(resolvePluginIcon(undefined));
  });
});
