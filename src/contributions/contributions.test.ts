import { expect, test } from "nsh/test";
import type { CapabilityChannelContribution } from "../framework/contributions";
import { detectChannelContributions } from "./detect";
import { ocrChannelContributions } from "./ocr";
import { ttsChannelContributions } from "./tts";

type ErasedChannel = CapabilityChannelContribution<unknown, unknown, unknown>;

function builtInChannels(): ErasedChannel[] {
  return [
    ...(ttsChannelContributions as unknown as ErasedChannel[]),
    ...(ocrChannelContributions as unknown as ErasedChannel[]),
    ...(detectChannelContributions as unknown as ErasedChannel[]),
  ];
}

test("contributions: every built-in channel's default config parses", () => {
  for (const contribution of builtInChannels()) {
    expect(contribution.config.parse(contribution.config.defaults())).not.toBeNull();
  }
});

test("contributions: every built-in channel id is unique within its capability", () => {
  const seen = new Set<string>();
  for (const contribution of builtInChannels()) {
    const key = `${contribution.capability}:${contribution.id}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
});
