import { expect, test } from "nsh/test";
import type { CapabilityChannelDefinition } from "../framework/integrations";
import { detectChannelDefinitions } from "./detect";
import { ocrChannelDefinitions } from "./ocr";
import { ttsChannelDefinitions } from "./tts";

type ErasedChannel = CapabilityChannelDefinition<unknown, unknown, unknown>;

function builtInChannels(): ErasedChannel[] {
  return [
    ...(ttsChannelDefinitions as unknown as ErasedChannel[]),
    ...(ocrChannelDefinitions as unknown as ErasedChannel[]),
    ...(detectChannelDefinitions as unknown as ErasedChannel[]),
  ];
}

test("integrations: every built-in channel's default config parses", () => {
  for (const definition of builtInChannels()) {
    expect(definition.config.parse(definition.config.defaults())).not.toBeNull();
  }
});

test("integrations: every built-in channel id is unique within its capability", () => {
  const seen = new Set<string>();
  for (const definition of builtInChannels()) {
    const key = `${definition.capability}:${definition.id}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});
