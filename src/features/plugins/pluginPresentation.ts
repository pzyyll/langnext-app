// ABOUTME: Resolves sanitized plugin labels and closed host icon IDs for plugin-facing UI.
// ABOUTME: Does not accept arbitrary assets, HTML, or executable presentation metadata.
import type { ServiceIntegrationDefinitionDto } from "../../storage/types";

export type PluginTextLookup = (key: string, options: { defaultValue: string }) => string;
/** Closed icon IDs that application components may map to bundled Iconify icons. */
export type PluginIconId = "google-cloud" | "google-translate-web" | "edge-tts" | "extension";

type PluginPresentationInput = Pick<ServiceIntegrationDefinitionDto, "displayNameKey" | "id" | "presentation">;

const iconById: Readonly<Record<string, PluginIconId>> = {
  "google-cloud": "google-cloud",
  "google-translate-web": "google-translate-web",
  "edge-tts": "edge-tts",
};

const fallbackIcon: PluginIconId = "extension";

/** Resolve a localized label while always retaining the trusted fallback string. */
export function resolveLocalizedText(
  lookup: PluginTextLookup,
  key: string | undefined,
  fallback: string | undefined,
): string {
  if (!key) {
    return fallback ?? "";
  }
  return lookup(key, { defaultValue: fallback ?? key });
}

/** Resolve the display label of an IPC definition without plugin-ID heuristics. */
export function resolvePluginDisplayName(definition: PluginPresentationInput, lookup: PluginTextLookup): string {
  return resolveLocalizedText(
    lookup,
    definition.displayNameKey,
    definition.presentation.displayNameFallback || definition.id,
  );
}

/** Resolve a closed host icon ID, falling back to the generic extension icon for unknown IDs. */
export function resolvePluginIcon(iconId: string | undefined): PluginIconId {
  return (iconId && iconById[iconId]) || fallbackIcon;
}
