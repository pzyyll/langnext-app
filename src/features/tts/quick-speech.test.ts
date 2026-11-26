import { expect, test } from "nsh/test";
import { t } from "nsh/i18n";
import { ttsChannelContributions } from "../../contributions/tts";
import {
  DEFAULT_GOOGLE_VOICE_PREFERENCES,
  type GoogleVoicePreferences,
} from "../../contributions/tts/vendor/google-preferences";
import type { ChannelCollection } from "../../framework/contributions/channel-collection";
import { createChannelCollection } from "../../framework/contributions/channel-collection";
import { createCredentialVault } from "../../framework/contributions/credential-vault";
import {
  createContributionRegistry,
  getContributionRegistry,
  setContributionRegistry,
} from "../../framework/contributions/registry";
import { prepareQuickSpeech, type QuickSpeechChannels } from "./quick-speech";

const STORAGE_KEY = "integrations.tts.v1";
const VAULT_NAMESPACE = "secret.tts";

function memoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  const storage = {
    getItem: async (key: string) => backing[key] ?? null,
    setItem: async (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: async (key: string) => {
      delete backing[key];
    },
  };
  return { backing, storage };
}

interface Seeded {
  backing: Record<string, string>;
  collection: ChannelCollection;
}

function makeCollection(): Seeded {
  const memory = memoryStorage();
  const registry = createContributionRegistry();
  for (const contribution of ttsChannelContributions) registry.registerCapability(contribution);
  setContributionRegistry(registry);
  const collection = createChannelCollection({
    capability: "tts",
    storage: memory.storage,
    storageKey: STORAGE_KEY,
    vault: createCredentialVault({ storage: memory.storage, namespace: VAULT_NAMESPACE }),
    contributions: () => getContributionRegistry().capabilities("tts"),
    policy: { enableOnFirstSave: false, requireReadableCredentialOnEnable: true },
  });
  return { backing: memory.backing, collection };
}

function googlePreferences(
  overrides: Partial<GoogleVoicePreferences> = {},
): GoogleVoicePreferences {
  return { ...DEFAULT_GOOGLE_VOICE_PREFERENCES, ...overrides };
}

async function seedGoogle(
  options: {
    enabled?: boolean;
    preferences?: GoogleVoicePreferences;
    key?: string;
  } = {},
): Promise<Seeded> {
  const seeded = makeCollection();
  await seeded.collection.load();
  await seeded.collection.add("google-cloud");
  await seeded.collection.save(
    "google-cloud",
    { preferences: options.preferences ?? googlePreferences() },
    { mode: "replace", value: { apiKey: options.key ?? "google-key" } },
  );
  if (options.enabled !== false) {
    expect(await seeded.collection.setEnabled("google-cloud", true)).toEqual({ ok: true });
  }
  return seeded;
}

async function seedAzure(options: { region?: string; key?: string } = {}): Promise<Seeded> {
  const seeded = makeCollection();
  await seeded.collection.load();
  await seeded.collection.add("azure");
  await seeded.collection.save(
    "azure",
    { region: options.region ?? "eastus" },
    { mode: "replace", value: { apiKey: options.key ?? "azure-key" } },
  );
  expect(await seeded.collection.setEnabled("azure", true)).toEqual({ ok: true });
  return seeded;
}

function channelAccess(collection: ChannelCollection, reads: string[]): QuickSpeechChannels {
  return {
    activeChannel: () => collection.activeChannel(),
    contribution: (id) => collection.contribution(id),
    readCredential: async (ref) => {
      reads.push(ref ?? "");
      return collection.readCredential(ref);
    },
  };
}

function gatedAccess(
  collection: ChannelCollection,
  gate: Promise<void>,
  reads: string[],
): QuickSpeechChannels {
  return {
    activeChannel: () => collection.activeChannel(),
    contribution: (id) => collection.contribution(id),
    readCredential: async (ref) => {
      reads.push(ref ?? "");
      const pending = collection.readCredential(ref);
      await gate;
      return pending;
    },
  };
}

test("quick speech: over-limit text is refused before a key read", async () => {
  const { collection } = await seedGoogle();
  const reads: string[] = [];
  const result = await prepareQuickSpeech(
    { text: "a".repeat(5_001), language: "en" },
    channelAccess(collection, reads),
  );
  expect(result).toEqual({ ok: false, message: t("quickTranslate.speakTooLong") });
  expect(reads).toEqual([]);
});

test("quick speech: prepares the active Azure channel and drops a stale binding", async () => {
  const { collection } = await seedAzure();
  const voices = [
    ["en", "en-US", "en-US-JennyNeural"],
    ["zh", "zh-CN", "zh-CN-YunxiNeural"],
    ["fr", "fr-FR", "fr-FR-DeniseNeural"],
  ] as const;
  for (const [language, languageCode, voiceName] of voices) {
    const result = await prepareQuickSpeech({ text: "Hello", language }, collection);
    expect(result).toEqual({
      ok: true,
      speech: {
        channel: "azure",
        input: {
          text: "Hello",
          language,
          voice: { languageCode, voiceName },
        },
      },
    });
  }

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prepareQuickSpeech(
    { text: "Hello", language: "en" },
    gatedAccess(collection, gate, []),
  );
  const replaced = await collection.save(
    "azure",
    { region: "westus2" },
    { mode: "replace", value: { apiKey: "next-azure-key" } },
  );
  expect(replaced.ok).toBe(true);
  release();
  const stale = await pending;
  expect(stale.ok).toBe(false);
});

test("quick speech: applies a saved override and audio values to Google", async () => {
  const { collection } = await seedGoogle({
    preferences: googlePreferences({
      voiceOverrides: { en: "en-GB-Wavenet-A" },
      speakingRate: 1.25,
      pitch: 2,
    }),
  });
  const result = await prepareQuickSpeech({ text: "Hello", language: "en" }, collection);
  expect(result).toEqual({
    ok: true,
    speech: {
      channel: "google-cloud",
      input: {
        text: "Hello",
        language: "en",
        voice: { languageCode: "en-GB", voiceName: "en-GB-Wavenet-A" },
        audio: { speakingRate: 1.25, pitch: 2 },
      },
    },
  });
});

test("quick speech: default Google preferences use the catalog voice and no audio fields", async () => {
  const { collection } = await seedGoogle();
  const result = await prepareQuickSpeech({ text: "Hello", language: "en" }, collection);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected prepared speech");
  expect(result.speech.input.voice).toEqual({
    languageCode: "en-US",
    voiceName: "en-US-Standard-C",
  });
  expect(result.speech.input.audio).toBeUndefined();
});

test("quick speech: no eligible Google voice points to Settings before a key read", async () => {
  for (const [overrides, expected] of [
    [undefined, t("quickTranslate.speakVoiceNeedsSettings")],
    [{ hr: "hr-HR-Wavenet-A" }, t("quickTranslate.speakVoiceUnavailable")],
  ] as const) {
    const { collection } = await seedGoogle({
      preferences: googlePreferences({ voiceOverrides: overrides ?? {} }),
    });
    const reads: string[] = [];
    const result = await prepareQuickSpeech(
      { text: "Bok", language: "hr" },
      channelAccess(collection, reads),
    );
    expect(result).toEqual({ ok: false, message: expected });
    expect(reads).toEqual([]);
  }
});

test("quick speech: a Google preference change during the key read drops the request", async () => {
  const { collection } = await seedGoogle();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prepareQuickSpeech(
    { text: "Hello", language: "en" },
    gatedAccess(collection, gate, []),
  );
  const saved = await collection.save(
    "google-cloud",
    { preferences: googlePreferences({ speakingRate: 1.5 }) },
    { mode: "keep" },
  );
  expect(saved.ok).toBe(true);
  release();
  const stale = await pending;
  expect(stale.ok).toBe(false);
});

test("quick speech: Azure refuses illegal text and the app byte limit before a key read", async () => {
  const { collection } = await seedAzure();
  const reads: string[] = [];
  const access = channelAccess(collection, reads);
  const illegal = await prepareQuickSpeech(
    { text: "bad" + String.fromCharCode(0), language: "en" },
    access,
  );
  expect(illegal).toEqual({ ok: false, message: t("quickTranslate.speakInvalidText") });
  const tooLong = await prepareQuickSpeech({ text: "a".repeat(5_001), language: "en" }, access);
  expect(tooLong).toEqual({ ok: false, message: t("quickTranslate.speakTooLongAzure") });
  expect(reads).toEqual([]);
});

test("quick speech: the active contribution signature follows saved preferences", async () => {
  const { collection } = await seedGoogle();
  const before = collection.activeChannel()!;
  const beforeContribution = collection.contribution(before.id)!;
  const beforeSignature = beforeContribution.signature!(before.binding);
  const beforeResult = await prepareQuickSpeech({ text: "Hello", language: "en" }, collection);
  expect(beforeResult.ok).toBe(true);

  await collection.save(
    "google-cloud",
    { preferences: googlePreferences({ voiceTier: "neural2" }) },
    { mode: "keep" },
  );
  const after = collection.activeChannel()!;
  const afterSignature = collection.contribution(after.id)!.signature!(after.binding);
  expect(afterSignature).not.toBe(beforeSignature);
  const afterResult = await prepareQuickSpeech({ text: "Hello", language: "en" }, collection);
  expect(afterResult.ok).toBe(true);
  if (!beforeResult.ok || !afterResult.ok) throw new Error("expected prepared speech");
  expect(afterResult.speech.input.voice).not.toEqual(beforeResult.speech.input.voice);
});
