import { expect, open, test } from "nsh/test";
import { SPLIT_RAIL_STORAGE_KEYS } from "../../components/layout/split-rail";
import { LANGUAGE_DETECTION_STORAGE_KEY } from "../language-detection/settings";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { baiduCredentialStorageKey, OCR_STORAGE_KEY } from "../ocr/settings";
import { GOOGLE_CLOUD_TTS_URL, TTS_SAMPLE_TEXT } from "../tts/google-cloud";
import { TTS_STORAGE_KEY, ttsCredentialStorageKey } from "../tts/settings";
import { SELECTION_COPY_STORAGE_KEY } from "./selection-copy";
import { SILENT_LAUNCH_STORAGE_KEY } from "./silent-launch";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };
const COPY_SWITCH_HELP = {
  selectionCopy:
    "When the selection cannot be read directly, try copying it. This can replace your clipboard contents.",
  doubleCopy:
    "Reads copied text after two quick Ctrl+C presses and translates it with your enabled presets.",
  doubleCopyZh: "连续按两次 Ctrl+C 会读取复制的文本，并使用已启用的预设进行翻译。",
};

const OCR_PRIORITY_HINT = {
  en: "Enabled channels run in order from top to bottom. Later ones act as backups.",
  zh: "已启用的渠道按从上到下的顺序使用，其余作为备用。",
};

const DETECTION_PRIORITY_HINT = {
  en: "Enabled detectors run in order from top to bottom. Later ones act as backups.",
  zh: "已启用的检测器按从上到下的顺序使用，其余作为备用。",
};

const LANGUAGE_DETECTION_HELP = {
  en: {
    native: "With an Automatic target, other languages are translated into your native language.",
    preferred:
      "With an Automatic target, your native language is translated into the selected language.",
  },
  zh: {
    native: "目标语言设为自动时，非母语内容译为母语。",
    preferred: "目标语言设为自动时，母语内容译为所选的语言。",
  },
};

/** One saved v2 language detection record; each detector keeps its own enabled state and priority. */
function detectionRecord(options: {
  order?: readonly ("ai" | "google")[];
  enabled?: Partial<Record<"ai" | "google", boolean>>;
  modelId?: string | null;
  nativeLanguage?: string | null;
  preferredTranslationLanguage?: string | null;
}): string {
  const ai =
    options.modelId === undefined || options.modelId === null ? null : { modelId: options.modelId };
  return JSON.stringify({
    version: 2,
    order: options.order ?? ["ai", "google"],
    enabled: {
      ai: options.enabled?.ai ?? ai !== null,
      google: options.enabled?.google ?? false,
    },
    ai,
    nativeLanguage: options.nativeLanguage ?? null,
    preferredTranslationLanguage: options.preferredTranslationLanguage ?? null,
  });
}

/** One saved v3 OCR record; each channel keeps its own config, enabled state, and priority order. */
function ocrRecord(options: {
  order?: readonly ("ai" | "baidu")[];
  enabled?: Partial<Record<"ai" | "baidu", boolean>>;
  modelId?: string;
  baidu?: { operation: string; credentialRef: string };
}): string {
  const ai = options.modelId === undefined ? null : { modelId: options.modelId };
  const baidu = options.baidu ?? null;
  return JSON.stringify({
    version: 3,
    order: options.order ?? ["ai", "baidu"],
    enabled: {
      ai: options.enabled?.ai ?? ai !== null,
      baidu: options.enabled?.baidu ?? baidu !== null,
    },
    ai,
    baidu,
  });
}

test("settings ui: groups language under General and theme under Appearance in a split view", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-page");
  expect(app.shows("id:settings-rail")).toBe(true);
  expect(app.shows("id:settings-detail")).toBe(true);
  expect(app.shows("id:settings-nav-general")).toBe(true);
  expect(app.shows("id:settings-nav-appearance")).toBe(true);
  expect(app.shows("role:button[General]")).toBe(true);
  expect(app.shows("role:button[Appearance]")).toBe(true);
  expect(app.shows("role:button[Shortcuts]")).toBe(true);

  // Rail categories belong to two groups: Application and Integrations.
  expect(app.shows("id:settings-group-application")).toBe(true);
  expect(app.shows("id:settings-group-integrations")).toBe(true);
  expect(app.texts()).toContain("Application");
  expect(app.texts()).toContain("Integrations");

  // General is active by default and displays Language and Silent launch.
  expect(app.shows("id:settings-general-card")).toBe(true);
  expect(app.shows("id:settings-silent-launch-card")).toBe(true);
  expect(app.shows("id:language-system")).toBe(true);
  expect(app.shows("id:settings-theme-card")).toBe(false);
  expect(app.shows("id:theme-dark")).toBe(false);

  // Switching to Appearance shows Theme and transparency controls without Language.
  await app.press("id:settings-nav-appearance");
  expect(app.shows("id:settings-theme-card")).toBe(true);
  expect(app.shows("id:settings-transparency-card")).toBe(true);
  expect(app.shows("id:theme-dark")).toBe(true);
  expect(app.shows("id:settings-general-card")).toBe(false);
  expect(app.texts()).toContain("Theme");

  // Active category stays selected across sidebar destination switches in the same session.
  await app.press("id:nav-models");
  await app.waitFor("id:models-page");
  await app.press("id:nav-settings");
  await app.waitFor("id:settings-theme-card");
  expect(app.shows("id:theme-dark")).toBe(true);

  // Switching back to General restores Language and verifies zh-CN labels across both categories.
  await app.press("id:settings-nav-general");
  await app.press("id:language-zh-CN");
  expect(app.shows("role:button[通用]")).toBe(true);
  expect(app.shows("role:button[外观]")).toBe(true);
  expect(app.shows("role:button[快捷键]")).toBe(true);
  expect(app.texts()).toContain("通用");
  expect(app.texts()).toContain("语言");
  expect(app.texts()).toContain("应用");
  expect(app.texts()).toContain("集成");
  await app.press("id:settings-nav-appearance");
  expect(app.texts()).toContain("外观");
  expect(app.texts()).toContain("主题");
  expect(app.texts()).toContain("透明标题栏");
});

test("silent launch: saves the switch and starts the next launch in the background", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: { "settings.language": "en" } });
  expect(app.window("main").state()?.visible).toBe(true);

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-silent-launch-switch");
  expect(app.texts()).toContain("Silent launch");
  expect(app.storage()[SILENT_LAUNCH_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-silent-launch-switch");
  await app.waitUntil(() => app.storage()[SILENT_LAUNCH_STORAGE_KEY] === "true");
  // The switch only says what the next launch does: this window stays open.
  expect(app.window("main").state()?.visible).toBe(true);

  const silent = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  expect(silent.window("main").state()?.visible).toBe(false);

  await app.press("id:settings-silent-launch-switch");
  await app.waitUntil(() => app.storage()[SILENT_LAUNCH_STORAGE_KEY] === "false");
  const visible = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  expect(visible.window("main").state()?.visible).toBe(true);
});

test("silent launch: a failed write keeps the saved state and can be retried", async () => {
  let fail = true;
  const saved: Record<string, string> = { "settings.language": "en" };
  const app = await open(APP_ENTRY, {
    ...viewport,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => saved[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (key === SILENT_LAUNCH_STORAGE_KEY && fail) throw new Error("Storage unavailable");
          saved[key] = value;
        },
      },
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-silent-launch-switch");
  await app.waitFor("id:settings-silent-launch-error");
  expect(app.texts()).toContain("Could not save silent launch. Try again.");
  expect(saved[SILENT_LAUNCH_STORAGE_KEY]).toBeUndefined();

  fail = false;
  await app.press("id:settings-silent-launch-switch");
  await app.waitUntil(() => saved[SILENT_LAUNCH_STORAGE_KEY] === "true");
  expect(app.shows("id:settings-silent-launch-error")).toBe(false);
});

test("settings ui: resizes the settings split divider and persists width independently", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [SPLIT_RAIL_STORAGE_KEYS.models]: "210",
      [SPLIT_RAIL_STORAGE_KEYS.presets]: "225",
    },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-rail");
  await app.waitFor("label:Resize settings panel");

  await app.drag("label:Resize settings panel", { x: 80 });
  await app.waitUntil(() => Boolean(app.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]));
  const resized = Number(app.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]);
  expect(resized).toBeGreaterThan(240);
  expect(resized).toBeLessThanOrEqual(360);
  expect(app.storage()[SPLIT_RAIL_STORAGE_KEYS.models]).toBe("210");
  expect(app.storage()[SPLIT_RAIL_STORAGE_KEYS.presets]).toBe("225");

  const reopened = await open(APP_ENTRY, {
    ...viewport,
    storage: app.storage(),
  });
  await reopened.press("id:nav-settings");
  await reopened.waitFor("id:settings-rail");
  expect(reopened.storage()[SPLIT_RAIL_STORAGE_KEYS.settings]).toBe(String(resized));

  await reopened.setViewport(720, 520);
  expect(reopened.shows("id:settings-rail")).toBe(true);
  expect(reopened.shows("id:settings-detail")).toBe(true);
});

test("settings ui: renders cleanly at the minimum viewport in dark mode with reduced motion", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
    storage: { "settings.language": "zh-CN" },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-general-card");
  expect(app.shows("id:language-zh-CN")).toBe(true);

  await app.press("id:settings-nav-appearance");
  await app.waitFor("id:settings-theme-card");
  expect(app.shows("id:theme-dark")).toBe(true);
  expect(app.shows("id:settings-transparency-card")).toBe(true);

  await app.press("id:settings-nav-shortcuts");
  await app.waitFor("id:settings-translation-shortcuts-card");
  await app.waitFor(
    "id:settings-translation-shortcuts-card >> id:settings-quick-translate-shortcut-row",
  );
  expect(app.shows("id:settings-double-copy-card")).toBe(true);
  expect(app.texts()).toContain("打开快速翻译");
  expect(app.texts()).toContain("Alt+Shift+D");
  expect(
    app.shows(
      "id:settings-translation-shortcuts-card >> id:settings-screenshot-translate-shortcut-row",
    ),
  ).toBe(true);
  expect(app.texts()).toContain("截图翻译");
  expect(app.texts()).toContain("Alt+Shift+S");
  expect(app.shows("id:settings-screenshot-translate-shortcut-reset")).toBe(false);
  expect(app.shows("id:settings-quick-translate-shortcut-reset")).toBe(false);
  expect(app.shows("id:settings-double-copy-switch")).toBe(true);
  expect(app.texts()).toContain("模拟复制获取文本");
});

test("selection copy: defaults off and restores the saved setting", async () => {
  const switchId = "id:settings-selection-copy-switch";
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.waitFor(switchId);
  expect(app.texts()).toContain("Simulate Copy to Get Text");
  expect(app.texts()).not.toContain(COPY_SWITCH_HELP.selectionCopy);
  await app.hover("id:settings-selection-copy-label");
  await app.waitUntil(() => app.texts().includes(COPY_SWITCH_HELP.selectionCopy));
  expect(app.storage()[SELECTION_COPY_STORAGE_KEY]).toBeUndefined();

  await app.press(switchId);
  await app.waitUntil(() => app.storage()[SELECTION_COPY_STORAGE_KEY] === "true");
  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-shortcuts");
  await reopened.press(switchId);
  await reopened.waitUntil(() => reopened.storage()[SELECTION_COPY_STORAGE_KEY] === "false");
});

test("selection copy: a failed write keeps the fallback off and can be retried", async () => {
  const switchId = "id:settings-selection-copy-switch";
  let fail = true;
  const saved: Record<string, string> = { "settings.language": "en" };
  const app = await open(APP_ENTRY, {
    ...viewport,
    modules: {
      nsh: {
        "Storage.getItem": async (key: string) => saved[key] ?? null,
        "Storage.setItem": async (key: string, value: string) => {
          if (key === SELECTION_COPY_STORAGE_KEY && fail) throw new Error("Storage unavailable");
          saved[key] = value;
        },
      },
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-shortcuts");
  await app.press(switchId);
  await app.waitFor("id:settings-selection-copy-error");
  expect(saved[SELECTION_COPY_STORAGE_KEY]).toBeUndefined();

  fail = false;
  await app.press(switchId);
  await app.waitUntil(() => saved[SELECTION_COPY_STORAGE_KEY] === "true");
  expect(app.shows("id:settings-selection-copy-error")).toBe(false);
});

test("double copy: shows Windows-only opt-in off by default, hides outside Windows, and surfaces startup or enable failures", async () => {
  const macApp = await open(APP_ENTRY, {
    ...viewport,
    platform: "macos",
    storage: { "settings.language": "en" },
  });
  await macApp.press("id:nav-settings");
  await macApp.press("id:settings-nav-shortcuts");
  await macApp.waitFor("id:settings-shortcuts-windows-only");
  expect(macApp.shows("id:settings-double-copy-card")).toBe(false);
  expect(macApp.shows("id:settings-selection-copy-switch")).toBe(false);
  expect(macApp.shows("id:settings-quick-translate-shortcut")).toBe(false);
  expect(macApp.shows("id:settings-translation-shortcuts-card")).toBe(false);

  const winApp = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await winApp.press("id:nav-settings");
  await winApp.waitFor("id:settings-general-card");
  expect(winApp.shows("id:settings-double-copy-card")).toBe(false);
  await winApp.press("id:settings-nav-shortcuts");
  await winApp.waitFor("id:settings-double-copy-card");
  expect(winApp.shows("id:settings-double-copy-switch")).toBe(true);
  expect(winApp.storage()["quickTranslate.preferences.v1"]).toBeUndefined();
  expect(winApp.texts()).not.toContain(COPY_SWITCH_HELP.doubleCopy);
  await winApp.hover("id:settings-double-copy-label");
  await winApp.waitUntil(() => winApp.texts().includes(COPY_SWITCH_HELP.doubleCopy));

  await winApp.press("id:settings-double-copy-switch");
  await winApp.waitUntil(() => Boolean(winApp.storage()["quickTranslate.preferences.v1"]));
  expect(JSON.parse(winApp.storage()["quickTranslate.preferences.v1"]!)).toMatchObject({
    version: 1,
    doubleCopyEnabled: true,
  });

  // Switch to zh-CN and verify localized copy.
  await winApp.press("id:settings-nav-general");
  await winApp.press("id:language-zh-CN");
  await winApp.press("id:settings-nav-shortcuts");
  await winApp.waitUntil(() => winApp.texts().some((text) => text.includes("双击 Ctrl+C")));
  await winApp.hover("id:settings-double-copy-label");
  await winApp.waitUntil(() => winApp.texts().includes(COPY_SWITCH_HELP.doubleCopyZh));

  // Toggle back off.
  await winApp.press("id:settings-double-copy-switch");
  await winApp.waitUntil(
    () =>
      JSON.parse(winApp.storage()["quickTranslate.preferences.v1"]!).doubleCopyEnabled === false,
  );

  // Enable failure keeps listener inactive and surfaces localized alert without persisting enabled.
  const enableFail = await open("./__tests__/double-copy-settings-harness.tsx", {
    ...viewport,
    storage: {
      "settings.language": "en",
      "__test.dc.failMode": "throw",
    },
  });
  await enableFail.press("id:nav-settings");
  await enableFail.press("id:settings-nav-shortcuts");
  await enableFail.waitFor("id:settings-double-copy-switch");
  expect(enableFail.texts()).toContain("active=false|reads=0");
  await enableFail.press("id:settings-double-copy-switch");
  await enableFail.waitFor("id:settings-double-copy-error");
  expect(enableFail.texts()).toContain("active=false|reads=0");
  expect(enableFail.storage()["quickTranslate.preferences.v1"]).toBeUndefined();
  await enableFail.press("id:dc-harness-trigger");
  expect(enableFail.texts()).toContain("active=false|reads=0");

  // Startup failure with opted-in storage keeps listener inactive and shows localized error.
  const startupFail = await open("./__tests__/double-copy-settings-harness.tsx", {
    ...viewport,
    storage: {
      "settings.language": "en",
      "quickTranslate.preferences.v1": JSON.stringify({ version: 1, doubleCopyEnabled: true }),
      "__test.dc.failMode": "throw",
    },
  });
  await startupFail.waitUntil(() =>
    startupFail.texts().some((text) => text.includes("Windows double-copy listener")),
  );
  await startupFail.press("id:nav-settings");
  await startupFail.press("id:settings-nav-shortcuts");
  await startupFail.waitFor("id:settings-double-copy-error");
  expect(startupFail.texts()).toContain("active=false|reads=0");
  await startupFail.press("id:dc-harness-trigger");
  expect(startupFail.texts()).toContain("active=false|reads=0");
});

test("language detection: lists detectors, configures AI on its detail page, and returns via breadcrumb", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      makeModel({ id: "m-2", providerId: "ch-openai", modelKey: "gpt-4.1", enabled: true }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav-language-detection");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");

  expect(app.shows("id:settings-detection-channel-ai")).toBe(true);
  expect(app.shows("id:settings-detection-row-google")).toBe(true);
  expect(app.shows("id:settings-detection-priority-info")).toBe(true);
  expect(app.texts()).not.toContain(DETECTION_PRIORITY_HINT.en);
  await app.hover("id:settings-detection-priority-info");
  await app.waitUntil(() => app.texts().includes(DETECTION_PRIORITY_HINT.en));
  expect(app.enabled("id:settings-detection-toggle-ai")).toBe(false);
  expect(app.enabled("id:settings-detection-toggle-google")).toBe(true);
  expect(app.texts()).toContain("AI");
  expect(app.texts()).toContain("Google");
  expect(app.texts()).toContain("Not configured");
  expect(app.texts()).toContain("Free Google Translate endpoint");
  expect(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]).toBeUndefined();

  await app.hover("id:settings-detection-toggle-ai");
  await app.waitUntil(() => app.texts().includes("Configure this detector before enabling it."));

  await app.press("id:settings-detection-channel-ai");
  await app.waitFor("id:settings-detection-detail-card");
  expect(app.shows("id:settings-detection-breadcrumb")).toBe(true);
  expect(app.shows("id:settings-detection-breadcrumb-root")).toBe(true);
  expect(app.shows("id:settings-detection-detail-title")).toBe(true);
  expect(app.shows("id:settings-detection-priority-info")).toBe(false);
  expect(app.enabled("id:settings-detection-save")).toBe(false);

  await app.press("id:settings-detection-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.waitFor("id:settings-detection-save");
  expect(app.enabled("id:settings-detection-save")).toBe(true);

  await app.press("id:settings-detection-save");
  await app.waitUntil(() => Boolean(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]));
  expect(JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!)).toEqual({
    version: 2,
    order: ["ai", "google"],
    enabled: { ai: true, google: false },
    ai: { modelId: "m-1" },
    nativeLanguage: null,
    preferredTranslationLanguage: null,
  });
  expect(app.requests()).toHaveLength(0);

  await app.press("id:settings-detection-breadcrumb-root");
  await app.waitFor("id:settings-detection-card");
  expect(app.shows("id:settings-detection-detail-card")).toBe(false);
  expect(app.shows("id:settings-detection-role-ai")).toBe(true);
  expect(app.texts()).toContain("Primary");
  expect(app.texts()).toContain("OpenAI Main · gpt-4.1-mini");
  expect(app.enabled("id:settings-detection-toggle-ai")).toBe(true);

  await app.press("id:settings-detection-toggle-google");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).enabled.google === true,
  );
  expect(app.shows("id:settings-detection-role-google")).toBe(true);
  expect(app.texts()).toContain("Backup");

  await app.press("id:settings-nav-general");
  await app.waitFor("id:settings-general-card");
  expect(app.shows("id:settings-detection-card")).toBe(false);
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.texts()).toContain("OpenAI Main · gpt-4.1-mini");

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-card");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1-mini");
  expect(reopened.shows("id:settings-detection-role-ai")).toBe(true);
  expect(reopened.shows("id:settings-detection-role-google")).toBe(true);
  expect(reopened.requests()).toHaveLength(0);

  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-card");
  expect(reopened.texts()).not.toContain(DETECTION_PRIORITY_HINT.zh);
  await reopened.hover("id:settings-detection-priority-info");
  await reopened.waitUntil(() => reopened.texts().includes(DETECTION_PRIORITY_HINT.zh));
  expect(reopened.texts()).toContain("首选");
  expect(reopened.texts()).toContain("备用");
  await reopened.press("id:settings-detection-channel-ai");
  await reopened.waitFor("id:settings-detection-detail-card");
  expect(reopened.texts()).toContain("模型");
});

test("language detection: saves preferences and rejects identical languages", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-preferences-card");
  expect(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-detection-native-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");
  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[English]");
  await app.press("role:option[English]");
  await app.press("id:settings-detection-save");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).nativeLanguage === "zh",
  );
  expect(JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!)).toMatchObject({
    version: 2,
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });

  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");
  await app.press("id:settings-detection-save");
  await app.waitFor("id:settings-detection-error");
  expect(app.texts()).toContain(
    "The native language and the preferred translation language must differ.",
  );
  expect(
    JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).preferredTranslationLanguage,
  ).toBe("en");

  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[German]");
  await app.press("role:option[German]");
  await app.press("id:settings-detection-save");
  await app.waitUntil(
    () =>
      JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).preferredTranslationLanguage ===
      "de",
  );
  expect(app.shows("id:settings-detection-error")).toBe(false);
  expect(app.requests()).toHaveLength(0);

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-preferences-card");
  expect(reopened.texts()).toContain("Chinese");
  expect(reopened.texts()).toContain("German");
});

test("language detection: keeps unavailable saved models and offers Models recovery", async () => {
  const savedSettings = detectionRecord({
    enabled: { ai: true },
    modelId: "m-removed",
    nativeLanguage: "zh",
  });
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
    ],
    extra: { [LANGUAGE_DETECTION_STORAGE_KEY]: savedSettings },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-summary-ai");
  expect(app.texts()).toContain("Model no longer exists in Models.");
  expect(app.enabled("id:settings-detection-toggle-ai")).toBe(true);

  await app.press("id:settings-detection-channel-ai");
  await app.waitFor("id:settings-detection-detail-card");
  expect(app.shows("id:settings-detection-model-unavailable")).toBe(true);
  expect(app.shows("id:settings-detection-manage-models")).toBe(true);
  await app.press("id:settings-detection-manage-models");
  await app.waitFor("id:models-page");

  const emptyCatalog = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      extra: { [LANGUAGE_DETECTION_STORAGE_KEY]: savedSettings },
    }),
  });
  await emptyCatalog.press("id:nav-settings");
  await emptyCatalog.press("id:settings-nav-language-detection");
  await emptyCatalog.waitFor("id:settings-detection-summary-ai");
  expect(emptyCatalog.texts()).toContain("Model no longer exists in Models.");
  await emptyCatalog.press("id:settings-detection-channel-ai");
  await emptyCatalog.waitFor("id:settings-detection-models-recovery");
  await emptyCatalog.press("id:settings-detection-manage-models");
  await emptyCatalog.waitFor("id:models-page");
});

test("language detection: reorders detectors and toggles enable state while preserving config", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      makeModel({ id: "m-2", providerId: "ch-openai", modelKey: "gpt-4.1", enabled: true }),
    ],
    extra: {
      [LANGUAGE_DETECTION_STORAGE_KEY]: detectionRecord({
        enabled: { ai: true, google: true },
        modelId: "m-1",
      }),
    },
  });

  const app = await open(APP_ENTRY, { ...viewport, storage: seed });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");

  expect(app.shows("id:settings-detection-grip-ai")).toBe(true);
  expect(app.shows("id:settings-detection-grip-google")).toBe(true);
  expect(app.shows("id:settings-detection-role-ai")).toBe(true);
  expect(app.shows("id:settings-detection-role-google")).toBe(true);

  // Dragging the second row above the first persists the new priority order.
  await app.drag("id:settings-detection-row-google", { x: 0, y: -80 });
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).order[0] === "google",
  );

  await app.press("id:settings-detection-toggle-ai");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).enabled.ai === false,
  );
  expect(app.shows("id:settings-detection-role-ai")).toBe(false);
  expect(app.shows("id:settings-detection-role-google")).toBe(true);
  expect(app.texts()).toContain("OpenAI Main · gpt-4.1-mini");

  await app.press("id:settings-detection-channel-ai");
  await app.waitFor("id:settings-detection-detail-card");
  await app.press("id:settings-detection-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.press("id:settings-detection-save");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).ai.modelId === "m-2",
  );
  expect(JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).enabled.ai).toBe(false);

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-card");
  expect(JSON.parse(reopened.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).order).toEqual([
    "google",
    "ai",
  ]);
  expect(reopened.shows("id:settings-detection-role-google")).toBe(true);
  expect(reopened.shows("id:settings-detection-role-ai")).toBe(false);
});

test("language detection: the grip reorders detectors with the arrow keys and keeps the focus", async () => {
  // A Linux host delivers raw keys to the focused view, as a desktop does.
  const app = await open(APP_ENTRY, { ...viewport, platform: "linux" });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");

  await app.press("id:settings-detection-grip-ai");
  await app.keyboard.press("arrowdown");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).order[0] === "google",
  );

  // The grip keeps the focus across the reorder, so the next key moves it back.
  await app.keyboard.press("arrowup");
  await app.waitUntil(
    () => JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).order[0] === "ai",
  );
});

test("language detection: keeps previous order and enabled state on a failed list write", async () => {
  const failing = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      ],
      extra: {
        [LANGUAGE_DETECTION_STORAGE_KEY]: detectionRecord({
          order: ["google", "ai"],
          enabled: { ai: false, google: false },
          modelId: "m-1",
        }),
      },
    }),
    modules: {
      nsh: {
        "Storage.setItem": async (key: string) => {
          if (key === LANGUAGE_DETECTION_STORAGE_KEY) throw new Error("Simulated write failure");
        },
      },
    },
  });
  await failing.press("id:nav-settings");
  await failing.press("id:settings-nav-language-detection");
  await failing.waitFor("id:settings-detection-card");

  await failing.press("id:settings-detection-toggle-google");
  await failing.waitFor("id:settings-detection-list-error");
  expect(JSON.parse(failing.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).enabled.google).toBe(false);

  await failing.drag("id:settings-detection-row-ai", { x: 0, y: -80 });
  await failing.wait(600);
  await failing.waitFor("id:settings-detection-list-error");
  expect(JSON.parse(failing.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).order).toEqual([
    "google",
    "ai",
  ]);
});

test("language detection: localizes detector labels and preference help in both languages", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: { "settings.language": "en" } });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.texts()).toContain("Language Detection");
  expect(app.texts()).toContain("AI");
  expect(app.texts()).toContain("Google");
  expect(app.texts()).toContain("Not configured");
  expect(app.texts()).toContain("Free Google Translate endpoint");
  expect(app.texts()).toContain("Detection languages");
  expect(app.texts()).toContain("Native language");
  expect(app.texts()).toContain("Translate my native language into");

  expect(app.texts()).not.toContain(LANGUAGE_DETECTION_HELP.en.native);
  await app.hover("id:settings-detection-native-language-label");
  await app.waitUntil(() => app.texts().includes(LANGUAGE_DETECTION_HELP.en.native));
  await app.hover("id:settings-detection-preferred-language-label");
  await app.waitUntil(() => app.texts().includes(LANGUAGE_DETECTION_HELP.en.preferred));

  await app.press("id:settings-nav-general");
  await app.press("id:language-zh-CN");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.texts()).toContain("语言检测");
  expect(app.texts()).toContain("未配置");
  expect(app.texts()).toContain("免费的 Google 翻译接口");
  expect(app.texts()).toContain("检测语言");
  expect(app.texts()).toContain("母语");
  expect(app.texts()).toContain("母语译为");
  expect(app.texts()).not.toContain(LANGUAGE_DETECTION_HELP.zh.native);
  await app.hover("id:settings-detection-native-language-label");
  await app.waitUntil(() => app.texts().includes(LANGUAGE_DETECTION_HELP.zh.native));
  await app.hover("id:settings-detection-preferred-language-label");
  await app.waitUntil(() => app.texts().includes(LANGUAGE_DETECTION_HELP.zh.preferred));
});

test("language detection: renders detector list and detail in dark compact mode with reduced motion", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      ],
      extra: {
        "settings.language": "zh-CN",
        [LANGUAGE_DETECTION_STORAGE_KEY]: detectionRecord({
          enabled: { ai: true },
          modelId: "m-1",
          nativeLanguage: "zh",
          preferredTranslationLanguage: "en",
        }),
      },
    }),
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.shows("id:settings-detection-role-ai")).toBe(true);
  expect(app.shows("id:settings-detection-preferences-card")).toBe(true);
  await app.press("id:settings-detection-channel-ai");
  await app.waitFor("id:settings-detection-detail-card");
  expect(app.shows("id:settings-detection-priority-info")).toBe(false);
  expect(app.shows("id:settings-detection-preferences-card")).toBe(false);
});

test("ocr settings: lists all channels, configures AI OCR on its detail page, and returns via breadcrumb", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({
        id: "m-vision",
        providerId: "ch-openai",
        modelKey: "gpt-4.1",
        enabled: true,
        capabilities: { text: true, image: true, pdf: false, video: false },
      }),
      makeModel({
        id: "m-text",
        providerId: "ch-openai",
        modelKey: "gpt-4.1-mini",
        enabled: true,
        capabilities: { text: true, image: false, pdf: false, video: false },
      }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav-ocr");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");

  expect(app.shows("id:settings-ocr-channel-ai")).toBe(true);
  expect(app.shows("id:settings-ocr-channel-baidu")).toBe(true);
  expect(app.shows("id:settings-ocr-priority-info")).toBe(true);
  expect(app.texts()).not.toContain(OCR_PRIORITY_HINT.en);
  await app.hover("id:settings-ocr-priority-info");
  await app.waitUntil(() => app.texts().includes(OCR_PRIORITY_HINT.en));
  expect(app.enabled("id:settings-ocr-toggle-ai")).toBe(false);
  expect(app.enabled("id:settings-ocr-toggle-baidu")).toBe(false);
  expect(app.texts()).toContain("AI OCR");
  expect(app.texts()).toContain("Baidu OCR");
  expect(app.texts()).toContain("Not configured");
  expect(app.storage()[OCR_STORAGE_KEY]).toBeUndefined();

  await app.hover("id:settings-ocr-toggle-ai");
  await app.waitUntil(() => app.texts().includes("Configure this channel before enabling it."));

  await app.press("id:settings-ocr-channel-ai");
  await app.waitFor("id:settings-ocr-detail-card");
  expect(app.shows("id:settings-ocr-breadcrumb")).toBe(true);
  expect(app.shows("id:settings-ocr-breadcrumb-root")).toBe(true);
  expect(app.shows("id:settings-ocr-detail-title")).toBe(true);
  expect(app.enabled("id:settings-ocr-save")).toBe(false);

  await app.press("id:settings-ocr-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  expect(app.texts()).not.toContain("OpenAI Main · gpt-4.1-mini");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.waitFor("id:settings-ocr-save");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);

  await app.press("id:settings-ocr-save");
  await app.waitUntil(() => Boolean(app.storage()[OCR_STORAGE_KEY]));
  expect(JSON.parse(app.storage()[OCR_STORAGE_KEY]!)).toEqual({
    version: 3,
    order: ["ai", "baidu"],
    enabled: { ai: true, baidu: false },
    ai: { modelId: "m-vision" },
    baidu: null,
  });
  expect(app.requests()).toHaveLength(0);

  await app.press("id:settings-ocr-breadcrumb-root");
  await app.waitFor("id:settings-ocr-card");
  expect(app.shows("id:settings-ocr-detail-card")).toBe(false);
  expect(app.shows("id:settings-ocr-role-ai")).toBe(true);
  expect(app.texts()).toContain("Primary");
  expect(app.texts()).toContain("OpenAI Main · gpt-4.1");
  expect(app.enabled("id:settings-ocr-toggle-ai")).toBe(true);

  // Leaving the category and returning keeps the saved configuration.
  await app.press("id:settings-nav-general");
  await app.waitFor("id:settings-general-card");
  expect(app.shows("id:settings-ocr-card")).toBe(false);
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");
  expect(app.texts()).toContain("OpenAI Main · gpt-4.1");

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1");
  expect(reopened.shows("id:settings-ocr-role-ai")).toBe(true);
  expect(reopened.shows("id:settings-ocr-windows-only")).toBe(false);
  expect(reopened.requests()).toHaveLength(0);

  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).not.toContain(OCR_PRIORITY_HINT.zh);
  await reopened.hover("id:settings-ocr-priority-info");
  await reopened.waitUntil(() => reopened.texts().includes(OCR_PRIORITY_HINT.zh));
  expect(reopened.texts()).toContain("首选");
  expect(reopened.texts()).toContain("百度 OCR");
  await reopened.press("id:settings-ocr-channel-ai");
  await reopened.waitFor("id:settings-ocr-detail-card");
  expect(reopened.texts()).toContain("模型");
});

// Only the headless driver can simulate the platform independently of the host OS.
test("ocr settings: explains the capture platform on simulated macOS", async () => {
  const app = await open(APP_ENTRY, { ...viewport, platform: "macos" });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-windows-only");
});

test("ocr settings: keeps an unavailable saved model and offers Models recovery", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({
        id: "m-vision",
        providerId: "ch-openai",
        modelKey: "gpt-4.1",
        enabled: true,
        capabilities: { text: true, image: true, pdf: false, video: false },
      }),
    ],
    extra: {
      [OCR_STORAGE_KEY]: ocrRecord({ modelId: "m-removed" }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-summary-ai");
  expect(app.texts()).toContain("Model no longer exists in Models.");

  await app.press("id:settings-ocr-channel-ai");
  await app.waitFor("id:settings-ocr-model-unavailable");
  expect(app.texts()).toContain("Model no longer exists in Models.");
  expect(app.shows("id:settings-ocr-manage-models")).toBe(true);
  expect(app.texts()).not.toContain("Deleted model");

  await app.press("id:settings-ocr-manage-models");
  await app.waitFor("id:models-page");

  // An image-incapable saved model is reported the same way, without an invalid option.
  const lostImage = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({
          id: "m-vision",
          providerId: "ch-openai",
          modelKey: "gpt-4.1",
          enabled: true,
          capabilities: { text: true, image: true, pdf: false, video: false },
          capabilitiesOverride: { image: false },
        }),
      ],
      extra: {
        [OCR_STORAGE_KEY]: ocrRecord({ modelId: "m-vision" }),
      },
    }),
  });
  await lostImage.press("id:nav-settings");
  await lostImage.press("id:settings-nav-ocr");
  await lostImage.press("id:settings-ocr-channel-ai");
  await lostImage.waitFor("id:settings-ocr-model-unavailable");
  expect(lostImage.texts()).toContain("Model does not support images.");
});

test("ocr settings: an empty catalog or a failed write keeps the active binding", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({
        id: "m-text",
        providerId: "ch-openai",
        modelKey: "gpt-4.1-mini",
        enabled: true,
        capabilities: { text: true, image: false, pdf: false, video: false },
      }),
    ],
    extra: {
      [OCR_STORAGE_KEY]: ocrRecord({ modelId: "m-vision" }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.press("id:settings-ocr-channel-ai");
  await app.waitFor("id:settings-ocr-models-recovery");
  expect(app.shows("id:settings-ocr-model")).toBe(true);
  expect(app.enabled("id:settings-ocr-model")).toBe(false);
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  await app.press("id:settings-ocr-manage-models");
  await app.waitFor("id:models-page");

  const failingWrite = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({
          id: "m-vision",
          providerId: "ch-openai",
          modelKey: "gpt-4.1",
          enabled: true,
          capabilities: { text: true, image: true, pdf: false, video: false },
        }),
        makeModel({
          id: "m-vision-2",
          providerId: "ch-openai",
          modelKey: "gpt-4o",
          enabled: true,
          capabilities: { text: true, image: true, pdf: false, video: false },
        }),
      ],
      extra: {
        [OCR_STORAGE_KEY]: ocrRecord({ modelId: "m-vision" }),
      },
    }),
    modules: {
      nsh: {
        "Storage.setItem": async (key: string) => {
          if (key === OCR_STORAGE_KEY) throw new Error("Simulated write failure");
        },
      },
    },
  });
  await failingWrite.press("id:nav-settings");
  await failingWrite.press("id:settings-nav-ocr");
  await failingWrite.press("id:settings-ocr-channel-ai");
  await failingWrite.waitFor("id:settings-ocr-detail-card");
  await failingWrite.press("id:settings-ocr-model");
  await failingWrite.waitFor("role:option[OpenAI Main · gpt-4o]");
  await failingWrite.press("role:option[OpenAI Main · gpt-4o]");
  await failingWrite.press("id:settings-ocr-save");
  await failingWrite.waitFor("id:settings-ocr-error");
  expect(failingWrite.texts()).toContain(
    "Could not save the OCR settings. Check storage and try again.",
  );
  expect(failingWrite.texts()).toContain("OpenAI Main · gpt-4o");
  expect(JSON.parse(failingWrite.storage()[OCR_STORAGE_KEY]!).ai.modelId).toBe("m-vision");
});

test("ocr settings: saves Baidu keys on detail page and restores a blank form", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: makeSeedStorage({}) });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");

  await app.press("id:settings-ocr-open-baidu");
  await app.waitFor("id:settings-ocr-detail-card");

  expect(app.texts()).toContain("Accurate with Location");
  expect(app.shows("id:settings-ocr-model")).toBe(false);
  expect(app.shows("id:settings-ocr-models-recovery")).toBe(false);
  expect(app.shows("id:settings-ocr-manage-models")).toBe(false);
  expect(app.enabled("id:settings-ocr-save")).toBe(false);

  await app.type("id:settings-ocr-baidu-api-key", "synthetic-api-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  await app.type("id:settings-ocr-baidu-secret-key", "synthetic-secret-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);

  await app.press("id:settings-ocr-save");
  await app.waitUntil(() => Boolean(app.storage()[OCR_STORAGE_KEY]));
  const saved = JSON.parse(app.storage()[OCR_STORAGE_KEY]!) as {
    version: number;
    order: string[];
    enabled: { ai: boolean; baidu: boolean };
    ai: unknown;
    baidu: { operation: string; credentialRef: string };
  };
  expect(saved.version).toBe(3);
  expect(saved.order).toEqual(["ai", "baidu"]);
  expect(saved.enabled).toEqual({ ai: false, baidu: true });
  expect(saved.ai).toBeNull();
  expect(saved.baidu.operation).toBe("accurate");
  expect(JSON.stringify(saved).includes("synthetic")).toBe(false);
  expect(JSON.parse(app.storage()[baiduCredentialStorageKey(saved.baidu.credentialRef)]!)).toEqual({
    apiKey: "synthetic-api-key",
    secretKey: "synthetic-secret-key",
  });
  expect(app.value("id:settings-ocr-baidu-api-key")).toBe("");
  expect(app.value("id:settings-ocr-baidu-secret-key")).toBe("");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);
  expect(app.requests()).toHaveLength(0);

  // Clicking OCR in the left rail also returns from the detail page to the list.
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");
  expect(app.shows("id:settings-ocr-role-baidu")).toBe(true);
  expect(app.texts()).toContain("Primary");
  expect(app.texts()).toContain("Accurate with Location");

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("Baidu OCR");
  expect(reopened.texts()).toContain("Accurate with Location");
  await reopened.press("id:settings-ocr-channel-baidu");
  await reopened.waitFor("id:settings-ocr-detail-card");
  expect(reopened.value("id:settings-ocr-baidu-api-key")).toBe("");
  expect(reopened.value("id:settings-ocr-baidu-secret-key")).toBe("");
  expect(reopened.requests()).toHaveLength(0);

  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("百度 OCR");
  expect(reopened.texts()).toContain("高精度含位置版");
  await reopened.press("id:settings-ocr-channel-baidu");
  await reopened.waitFor("id:settings-ocr-detail-card");
  expect(reopened.texts()).toContain("模式");
});

test("ocr settings: reorders channels and toggles enable state while preserving config", async () => {
  const ref = "saved-baidu-ref";
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({
        id: "m-vision",
        providerId: "ch-openai",
        modelKey: "gpt-4.1",
        enabled: true,
        capabilities: { text: true, image: true, pdf: false, video: false },
      }),
    ],
    extra: {
      [OCR_STORAGE_KEY]: ocrRecord({
        order: ["ai", "baidu"],
        enabled: { ai: true, baidu: true },
        modelId: "m-vision",
        baidu: { operation: "general", credentialRef: ref },
      }),
      [baiduCredentialStorageKey(ref)]: JSON.stringify({
        apiKey: "saved-api-key",
        secretKey: "saved-secret-key",
      }),
    },
  });

  const app = await open(APP_ENTRY, { ...viewport, storage: seed });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");

  expect(app.shows("id:settings-ocr-grip-ai")).toBe(true);
  expect(app.shows("id:settings-ocr-grip-baidu")).toBe(true);
  expect(app.shows("id:settings-ocr-role-ai")).toBe(true);
  expect(app.shows("id:settings-ocr-role-baidu")).toBe(true);

  // Dragging the second row above the first persists the new priority order.
  await app.drag("id:settings-ocr-row-baidu", { x: 0, y: -80 });
  await app.waitUntil(() => JSON.parse(app.storage()[OCR_STORAGE_KEY]!).order[0] === "baidu");

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(JSON.parse(reopened.storage()[OCR_STORAGE_KEY]!).order).toEqual(["baidu", "ai"]);

  // Disabling Baidu keeps its credentials & summary, and promotes AI to Primary.
  await reopened.press("id:settings-ocr-toggle-baidu");
  await reopened.waitUntil(
    () => JSON.parse(reopened.storage()[OCR_STORAGE_KEY]!).enabled.baidu === false,
  );
  expect(reopened.shows("id:settings-ocr-role-baidu")).toBe(false);
  expect(reopened.shows("id:settings-ocr-role-ai")).toBe(true);
  expect(reopened.texts()).toContain("General with Location");
  expect(reopened.storage()[baiduCredentialStorageKey(ref)]).toBe(
    JSON.stringify({ apiKey: "saved-api-key", secretKey: "saved-secret-key" }),
  );

  // Editing an already-configured disabled channel preserves its disabled state.
  await reopened.press("id:settings-ocr-channel-baidu");
  await reopened.waitFor("id:settings-ocr-detail-card");
  await reopened.press("id:settings-ocr-baidu-operation");
  await reopened.waitFor("role:option[Accurate Basic]");
  await reopened.press("role:option[Accurate Basic]");
  await reopened.press("id:settings-ocr-save");
  await reopened.waitUntil(
    () => JSON.parse(reopened.storage()[OCR_STORAGE_KEY]!).baidu.operation === "accurate_basic",
  );
  expect(JSON.parse(reopened.storage()[OCR_STORAGE_KEY]!).enabled.baidu).toBe(false);
});

test("ocr settings: the grip reorders channels with the arrow keys and keeps the focus", async () => {
  // A Linux host delivers raw keys to the focused view, as a desktop does.
  const app = await open(APP_ENTRY, { ...viewport, platform: "linux" });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");

  await app.press("id:settings-ocr-grip-ai");
  await app.keyboard.press("arrowdown");
  await app.waitUntil(() => JSON.parse(app.storage()[OCR_STORAGE_KEY]!).order[0] === "baidu");

  // The grip keeps the focus across the reorder, so the next key moves it back.
  await app.keyboard.press("arrowup");
  await app.waitUntil(() => JSON.parse(app.storage()[OCR_STORAGE_KEY]!).order[0] === "ai");
});

test("ocr settings: keeps previous order and enabled state on a failed list write", async () => {
  const ref = "saved-baidu-ref";
  const failing = await open(APP_ENTRY, {
    ...viewport,
    storage: makeSeedStorage({
      extra: {
        [OCR_STORAGE_KEY]: ocrRecord({
          order: ["baidu", "ai"],
          enabled: { ai: false, baidu: false },
          baidu: { operation: "accurate_basic", credentialRef: ref },
        }),
        [baiduCredentialStorageKey(ref)]: JSON.stringify({
          apiKey: "saved-api-key",
          secretKey: "saved-secret-key",
        }),
      },
    }),
    modules: {
      nsh: {
        "Storage.setItem": async (key: string) => {
          if (key === OCR_STORAGE_KEY) throw new Error("Simulated write failure");
        },
      },
    },
  });
  await failing.press("id:nav-settings");
  await failing.press("id:settings-nav-ocr");
  await failing.waitFor("id:settings-ocr-card");
  await failing.press("id:settings-ocr-toggle-baidu");
  await failing.waitFor("id:settings-ocr-list-error");
  expect(JSON.parse(failing.storage()[OCR_STORAGE_KEY]!).enabled.baidu).toBe(false);

  await failing.drag("id:settings-ocr-row-baidu", { x: 0, y: 80 });
  await failing.wait(600);
  await failing.waitFor("id:settings-ocr-list-error");
  expect(JSON.parse(failing.storage()[OCR_STORAGE_KEY]!).order).toEqual(["baidu", "ai"]);
});

test("ocr settings: unreadable Baidu keys and a failed write leave the binding", async () => {
  const ref = "broken-baidu-ref";
  const broken = makeSeedStorage({
    extra: {
      [OCR_STORAGE_KEY]: ocrRecord({
        order: ["baidu", "ai"],
        enabled: { ai: false, baidu: true },
        baidu: { operation: "general", credentialRef: ref },
      }),
      [baiduCredentialStorageKey(ref)]: JSON.stringify({ apiKey: 1 }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: broken });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-summary-baidu");
  expect(app.texts()).toContain("The saved Baidu keys could not be read. Enter both keys.");

  await app.press("id:settings-ocr-channel-baidu");
  await app.waitFor("id:settings-ocr-baidu-keys-missing");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  await app.type("id:settings-ocr-baidu-api-key", "replacement-api-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  await app.type("id:settings-ocr-baidu-secret-key", "replacement-secret-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);

  const failing = await open(APP_ENTRY, {
    ...viewport,
    storage: broken,
    modules: {
      nsh: {
        "Storage.setItem": async (key: string) => {
          if (key === OCR_STORAGE_KEY) throw new Error("Simulated write failure");
        },
      },
    },
  });
  await failing.press("id:nav-settings");
  await failing.press("id:settings-nav-ocr");
  await failing.press("id:settings-ocr-channel-baidu");
  await failing.waitFor("id:settings-ocr-baidu-keys-missing");
  await failing.type("id:settings-ocr-baidu-api-key", "replacement-api-key");
  await failing.type("id:settings-ocr-baidu-secret-key", "replacement-secret-key");
  await failing.press("id:settings-ocr-save");
  await failing.waitFor("id:settings-ocr-error");
  expect(JSON.parse(failing.storage()[OCR_STORAGE_KEY]!).baidu.credentialRef).toBe(ref);
  expect(failing.value("id:settings-ocr-baidu-api-key")).toBe("replacement-api-key");
  expect(failing.value("id:settings-ocr-baidu-secret-key")).toBe("replacement-secret-key");
  expect(failing.requests()).toHaveLength(0);
});

test("ocr settings: renders cleanly at minimum viewport in dark mode with reduced motion", async () => {
  const ref = "compact-baidu-ref";
  const app = await open(APP_ENTRY, {
    ...viewport,
    width: 720,
    height: 520,
    colorScheme: "dark",
    reducedMotion: true,
    storage: makeSeedStorage({
      channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
      models: [
        makeModel({
          id: "m-vision",
          providerId: "ch-openai",
          modelKey: "gpt-4.1",
          enabled: true,
          capabilities: { text: true, image: true, pdf: false, video: false },
        }),
      ],
      extra: {
        "settings.language": "zh-CN",
        [OCR_STORAGE_KEY]: ocrRecord({
          order: ["ai", "baidu"],
          enabled: { ai: true, baidu: true },
          modelId: "m-vision",
          baidu: { operation: "accurate", credentialRef: ref },
        }),
        [baiduCredentialStorageKey(ref)]: JSON.stringify({
          apiKey: "saved-api-key",
          secretKey: "saved-secret-key",
        }),
      },
    }),
  });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");
  expect(app.texts()).toContain("首选");
  expect(app.texts()).toContain("备用");

  await app.press("id:settings-ocr-channel-ai");
  await app.waitFor("id:settings-ocr-detail-card");
  expect(app.shows("id:settings-ocr-breadcrumb")).toBe(true);
  await app.press("id:settings-ocr-breadcrumb-root");
  await app.waitFor("id:settings-ocr-card");
});

test("tts settings: opens the Google Cloud channel and discards an unsaved key", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav-tts");
  await app.press("id:settings-nav-tts");
  await app.waitFor("id:settings-tts-card");

  expect(app.texts()).toContain("Text-to-Speech");
  expect(app.texts()).toContain("Google Cloud Text-to-Speech");
  expect(app.count("text:Google Cloud Text-to-Speech")).toBe(1);
  expect(app.texts()).toContain("Not configured");
  expect(app.enabled("id:settings-tts-toggle-google-cloud")).toBe(false);
  expect(app.shows("id:settings-tts-open-google-cloud")).toBe(true);
  await app.hover("id:settings-tts-toggle-google-cloud");
  await app.waitUntil(() => app.texts().includes("Configure this channel before enabling it."));

  await app.press("id:settings-tts-channel-google-cloud");
  await app.waitFor("id:settings-tts-detail-card");
  expect(app.shows("id:settings-tts-breadcrumb-root")).toBe(true);
  expect(app.texts()).toContain("Text-to-Speech");
  expect(app.texts()).toContain("Google Cloud Text-to-Speech");
  expect(app.shows("id:settings-tts-card")).toBe(false);

  await app.type("id:settings-tts-api-key", "draft-key");
  await app.press("id:settings-tts-breadcrumb-root");
  await app.waitFor("id:settings-tts-card");
  expect(app.shows("id:settings-tts-detail-card")).toBe(false);
  expect(app.storage()["settings.tts.v1"]).toBeUndefined();

  await app.press("id:settings-tts-open-google-cloud");
  await app.waitFor("id:settings-tts-detail-card");
  expect(app.value("id:settings-tts-api-key")).toBe("");
  await app.type("id:settings-tts-api-key", "another-draft");
  await app.press("id:settings-nav-tts");
  await app.waitFor("id:settings-tts-card");
  expect(app.value("id:settings-tts-api-key")).toBeNull();
  expect(app.storage()["settings.tts.v1"]).toBeUndefined();
  expect(app.requests().some((request) => String(request.url).includes("texttospeech"))).toBe(
    false,
  );
});

test("tts settings: enables on the first save and keeps a replaced key off", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: { "settings.language": "en" },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.press("id:settings-tts-open-google-cloud");
  await app.waitFor("id:settings-tts-detail-card");
  expect(app.enabled("id:settings-tts-save")).toBe(false);
  expect(app.texts()).not.toContain("The key is stored on this device and is not encrypted.");

  await app.type("id:settings-tts-api-key", "synthetic-tts-key");
  expect(app.enabled("id:settings-tts-save")).toBe(true);
  await app.press("id:settings-tts-save");
  await app.waitUntil(() => Boolean(app.storage()[TTS_STORAGE_KEY]));
  const saved = JSON.parse(app.storage()[TTS_STORAGE_KEY]!) as {
    version: number;
    googleCloud: { enabled: boolean; credentialRef: string };
  };
  expect(saved.version).toBe(1);
  expect(saved.googleCloud.enabled).toBe(true);
  expect(JSON.stringify(saved).includes("synthetic-tts-key")).toBe(false);
  expect(
    JSON.parse(app.storage()[ttsCredentialStorageKey(saved.googleCloud.credentialRef)]!),
  ).toEqual({ apiKey: "synthetic-tts-key" });
  expect(app.value("id:settings-tts-api-key")).toBe("");
  expect(app.enabled("id:settings-tts-save")).toBe(false);
  expect(app.requests().some((request) => request.url.includes("texttospeech"))).toBe(false);

  await app.press("id:settings-tts-breadcrumb-root");
  await app.waitFor("id:settings-tts-card");
  expect(app.texts()).toContain("Configured");
  await app.press("id:settings-tts-toggle-google-cloud");
  await app.waitUntil(
    () => JSON.parse(app.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled === false,
  );
  expect(app.requests().some((request) => request.url.includes("texttospeech"))).toBe(false);

  await app.press("id:settings-tts-channel-google-cloud");
  await app.waitFor("id:settings-tts-api-key");
  expect(app.value("id:settings-tts-api-key")).toBe("");
  await app.type("id:settings-tts-api-key", "replacement-tts-key");
  await app.press("id:settings-tts-save");
  await app.waitUntil(() => {
    const next = JSON.parse(app.storage()[TTS_STORAGE_KEY]!) as {
      googleCloud: { credentialRef: string; enabled: boolean };
    };
    return next.googleCloud.credentialRef !== saved.googleCloud.credentialRef;
  });
  const replaced = JSON.parse(app.storage()[TTS_STORAGE_KEY]!) as {
    googleCloud: { enabled: boolean; credentialRef: string };
  };
  expect(replaced.googleCloud.enabled).toBe(false);
  expect(
    JSON.parse(app.storage()[ttsCredentialStorageKey(replaced.googleCloud.credentialRef)]!),
  ).toEqual({ apiKey: "replacement-tts-key" });
  expect(app.storage()[ttsCredentialStorageKey(saved.googleCloud.credentialRef)]).toBeUndefined();
  expect(app.value("id:settings-tts-api-key")).toBe("");
  expect(app.texts()).not.toContain("synthetic-tts-key");
  expect(app.texts()).not.toContain("replacement-tts-key");

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-tts");
  await reopened.waitFor("id:settings-tts-card");
  expect(JSON.parse(reopened.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
  await reopened.press("id:settings-tts-open-google-cloud");
  await reopened.waitFor("id:settings-tts-api-key");
  expect(reopened.value("id:settings-tts-api-key")).toBe("");
  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-tts");
  await reopened.waitFor("id:settings-tts-card");
  expect(reopened.texts()).toContain("语音合成");
  expect(reopened.texts()).toContain("已配置");
  await reopened.press("id:settings-tts-channel-google-cloud");
  await reopened.waitFor("id:settings-tts-detail-card");
  expect(reopened.value("id:settings-tts-api-key")).toBe("");
});

test("tts settings: a missing key can be turned off", async () => {
  const ref = "broken-tts-ref";
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [TTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        googleCloud: { enabled: true, credentialRef: ref },
      }),
      [ttsCredentialStorageKey(ref)]: "not-json",
    },
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.waitFor("id:settings-tts-summary-google-cloud");
  expect(app.texts()).toContain("The saved API key could not be read. Enter it again.");
  expect(app.enabled("id:settings-tts-toggle-google-cloud")).toBe(true);
  await app.press("id:settings-tts-toggle-google-cloud");
  await app.waitUntil(
    () => JSON.parse(app.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled === false,
  );

  await app.press("id:settings-tts-toggle-google-cloud");
  await app.waitFor("id:settings-tts-list-error");
  expect(JSON.parse(app.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
  expect(app.texts()).toContain("The saved API key could not be read. Enter it again.");
});

test("tts storage: a failed save keeps the draft", async () => {
  const ref = "broken-tts-ref";
  const failing = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [TTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        googleCloud: { enabled: false, credentialRef: ref },
      }),
      [ttsCredentialStorageKey(ref)]: JSON.stringify({ apiKey: "kept-tts-key" }),
    },
    modules: {
      nsh: {
        "Storage.setItem": async (key: string) => {
          if (key === TTS_STORAGE_KEY) throw new Error("Simulated write failure");
        },
      },
    },
  });
  await failing.press("id:nav-settings");
  await failing.press("id:settings-nav-tts");
  await failing.press("id:settings-tts-toggle-google-cloud");
  await failing.waitFor("id:settings-tts-list-error");
  expect(JSON.parse(failing.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
  expect(failing.texts()).toContain(
    "Could not save the text-to-speech settings. Check storage and try again.",
  );

  await failing.press("id:settings-tts-open-google-cloud");
  await failing.waitFor("id:settings-tts-detail-card");
  await failing.type("id:settings-tts-api-key", "replacement-tts-key");
  await failing.press("id:settings-tts-save");
  await failing.waitFor("id:settings-tts-error");
  expect(failing.value("id:settings-tts-api-key")).toBe("replacement-tts-key");
  expect(JSON.parse(failing.storage()[TTS_STORAGE_KEY]!).googleCloud.credentialRef).toBe(ref);
  expect(JSON.parse(failing.storage()[ttsCredentialStorageKey(ref)]!).apiKey).toBe("kept-tts-key");
  expect(failing.requests().some((request) => request.url.includes("texttospeech"))).toBe(false);
});

const TTS_PREVIEW_MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x7f]);

function ttsPreviewNetwork(status = 200, body?: unknown) {
  return {
    ["POST " + GOOGLE_CLOUD_TTS_URL]: {
      status,
      body: body ?? { audioContent: Buffer.from(TTS_PREVIEW_MP3).toString("base64") },
    },
  };
}

function savedTtsStorage(enabled: boolean, apiKey = "saved-preview-key", ref = "preview-ref") {
  return {
    "settings.language": "en",
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      googleCloud: { enabled, credentialRef: ref },
    }),
    [ttsCredentialStorageKey(ref)]: JSON.stringify({ apiKey }),
  };
}

test("tts preview: plays the saved sample and ignores drafts, saves, and toggles", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: savedTtsStorage(false),
    network: ttsPreviewNetwork(),
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.press("id:settings-tts-open-google-cloud");
  await app.waitFor("id:settings-tts-preview");
  expect(app.requests()).toHaveLength(0);
  expect(app.texts()).not.toContain("Sends a short English sample to Google.");

  await app.type("id:settings-tts-api-key", "draft-preview-key");
  expect(app.enabled("id:settings-tts-preview")).toBe(false);
  await app.hover("id:settings-tts-preview");
  await app.waitUntil(() =>
    app.texts().includes("Save or clear the API key before playing the sample."),
  );
  expect(app.requests()).toHaveLength(0);
  await app.clear("id:settings-tts-api-key");
  await app.waitUntil(() => app.enabled("id:settings-tts-preview"));

  await app.press("id:settings-tts-preview");
  await app.waitFor("text:Stop");
  expect(app.requests()).toHaveLength(1);
  const request = app.requests()[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(GOOGLE_CLOUD_TTS_URL);
  expect(request.headers["x-goog-api-key"] ?? request.headers["X-Goog-Api-Key"]).toBe(
    "saved-preview-key",
  );
  expect(JSON.parse(request.body ?? "").input.text).toBe(TTS_SAMPLE_TEXT);
  expect(JSON.parse(request.body ?? "").voice).toEqual({
    languageCode: "en-US",
    name: "en-US-Standard-C",
  });
  expect(
    app.audio().some((call) => call.command === "open" && call.src.includes("tts-playback")),
  ).toBe(true);
  expect(app.enabled("id:settings-tts-api-key")).toBe(false);
  expect(app.enabled("id:settings-tts-save")).toBe(false);
  await app.endAudio();
  await app.waitFor("text:Play sample");
  expect(app.audio().some((call) => call.command === "close")).toBe(true);

  await app.type("id:settings-tts-api-key", "replacement-preview-key");
  await app.press("id:settings-tts-save");
  await app.waitUntil(() => {
    const saved = JSON.parse(app.storage()[TTS_STORAGE_KEY]!) as {
      googleCloud: { credentialRef: string; enabled: boolean };
    };
    return saved.googleCloud.credentialRef !== "preview-ref";
  });
  expect(app.requests()).toHaveLength(1);
  expect(JSON.parse(app.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled).toBe(false);
  await app.press("id:settings-tts-breadcrumb-root");
  await app.waitFor("id:settings-tts-card");
  await app.press("id:settings-tts-toggle-google-cloud");
  await app.waitUntil(
    () => JSON.parse(app.storage()[TTS_STORAGE_KEY]!).googleCloud.enabled === true,
  );
  expect(app.requests()).toHaveLength(1);
});

test("tts preview: reports an auth failure without opening a player", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: savedTtsStorage(true),
    network: ttsPreviewNetwork(401, {
      error: {
        message: "provider secret text",
        details: [{ reason: "API_KEY_INVALID" }],
      },
    }),
  });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.press("id:settings-tts-open-google-cloud");
  await app.waitUntil(() => app.enabled("id:settings-tts-preview"));
  await app.press("id:settings-tts-preview");
  await app.waitFor("id:settings-tts-preview-error");
  expect(app.texts()).toContain(
    "Check the API key, Cloud Text-to-Speech access, and project billing.",
  );
  expect(app.texts()).not.toContain("provider secret text");
  expect(app.audio()).toEqual([]);
  expect(app.texts()).toContain("Play sample");
});

test("tts preview: leaving or cancelling drops a late response and closes playback", async () => {
  const loading = await open(APP_ENTRY, {
    ...viewport,
    storage: savedTtsStorage(false),
    network: {
      ["POST " + GOOGLE_CLOUD_TTS_URL]: {
        status: 200,
        delay: 400,
        body: { audioContent: Buffer.from(TTS_PREVIEW_MP3).toString("base64") },
      },
    },
  });
  await loading.press("id:nav-settings");
  await loading.press("id:settings-nav-tts");
  await loading.press("id:settings-tts-open-google-cloud");
  await loading.waitUntil(() => loading.enabled("id:settings-tts-preview"));
  await loading.press("id:settings-tts-preview");
  await loading.waitFor("text:Cancel");
  await loading.press("id:settings-tts-breadcrumb-root");
  await loading.waitFor("id:settings-tts-card");
  await loading.wait(500);
  expect(loading.audio().some((call) => call.command === "open")).toBe(false);
  expect(loading.texts()).not.toContain("Could not play the sample. Try again.");

  const playing = await open(APP_ENTRY, {
    ...viewport,
    storage: savedTtsStorage(false),
    network: ttsPreviewNetwork(),
  });
  await playing.press("id:nav-settings");
  await playing.press("id:settings-nav-tts");
  await playing.press("id:settings-tts-open-google-cloud");
  await playing.waitUntil(() => playing.enabled("id:settings-tts-preview"));
  await playing.press("id:settings-tts-preview");
  await playing.waitFor("text:Stop");
  await playing.press("id:settings-tts-preview");
  await playing.waitFor("text:Play sample");
  expect(playing.requests()).toHaveLength(1);
  expect(playing.audio().some((call) => call.command === "close")).toBe(true);

  await playing.press("id:settings-tts-preview");
  await playing.waitFor("text:Stop");
  await playing.press("id:settings-tts-breadcrumb-root");
  await playing.waitFor("id:settings-tts-card");
  expect(playing.audio().filter((call) => call.command === "open").length).toBe(
    playing.audio().filter((call) => call.command === "close").length,
  );
});

test("tts settings: configures Azure and switches it on without a network call", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [TTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        googleCloud: { enabled: true, credentialRef: "google-ref" },
      }),
      [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    },
  });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav-tts");
  await app.press("id:settings-nav-tts");
  await app.waitFor("id:settings-tts-row-azure");
  const googleAt = app.texts().indexOf("Google Cloud Text-to-Speech");
  const azureAt = app.texts().indexOf("Azure Speech");
  expect(googleAt).toBeGreaterThanOrEqual(0);
  expect(azureAt).toBeGreaterThan(googleAt);
  expect(app.shows("id:settings-tts-open-azure")).toBe(true);

  await app.press("id:settings-tts-open-azure");
  await app.waitFor("id:settings-tts-region");
  expect(app.texts()).toContain("Azure Speech");
  expect(app.shows("id:settings-tts-breadcrumb-root")).toBe(true);
  await app.type("id:settings-tts-region", "eastus");
  await app.type("id:settings-tts-api-key", "azure-key");
  await app.press("id:settings-tts-save");
  await app.waitUntil(() => {
    const raw = app.storage()[TTS_STORAGE_KEY];
    return typeof raw === "string" && raw.includes("eastus");
  });
  expect(app.value("id:settings-tts-api-key")).toBe("");

  await app.press("id:settings-tts-breadcrumb-root");
  await app.waitFor("id:settings-tts-card");
  await app.press("id:settings-tts-toggle-azure");
  await app.waitUntil(() => {
    const raw = app.storage()[TTS_STORAGE_KEY];
    if (typeof raw !== "string") return false;
    const saved = JSON.parse(raw) as {
      googleCloud: { enabled: boolean };
      azure: { enabled: boolean; region: string } | null;
    };
    return saved.azure?.enabled === true && saved.googleCloud.enabled === false;
  });
  expect(app.requests().some((request) => String(request.url).includes("tts.speech"))).toBe(false);
  expect(app.requests().some((request) => String(request.url).includes("texttospeech"))).toBe(
    false,
  );
});

test("tts settings: shows the saved Azure region and names the channel a switch will turn off", async () => {
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [TTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        googleCloud: { enabled: true, credentialRef: "google-ref" },
        azure: { enabled: false, credentialRef: "azure-ref", region: "eastus" },
      }),
      [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
      [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
    },
  });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.waitFor("id:settings-tts-toggle-azure");
  await app.hover("id:settings-tts-toggle-azure");
  await app.waitUntil(() => app.texts().includes("Turn off Google Cloud Text-to-Speech"));
  expect(app.texts()).not.toContain("azure-key");
  expect(app.texts()).not.toContain("google-key");

  await app.press("id:settings-tts-open-azure");
  await app.waitFor("id:settings-tts-region");
  expect(app.value("id:settings-tts-region")).toBe("eastus");
  expect(app.value("id:settings-tts-api-key")).toBe("");
  expect(app.texts()).not.toContain("azure-key");
  await app.type("id:settings-tts-region", "2");
  expect(app.enabled("id:settings-tts-save")).toBe(false);
  await app.type("id:settings-tts-api-key", "next-azure-key");
  expect(app.enabled("id:settings-tts-save")).toBe(true);
  await app.press("id:settings-tts-save");
  await app.waitUntil(() => {
    const raw = app.storage()[TTS_STORAGE_KEY];
    return typeof raw === "string" && raw.includes("eastus2");
  });
  expect(app.value("id:settings-tts-api-key")).toBe("");
  expect(app.value("id:settings-tts-region")).toBe("eastus2");
  expect(app.texts()).not.toContain("next-azure-key");
});

test("tts preview: plays an Azure sample without changing the active channel", async () => {
  const azureUrl = "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1";
  const app = await open(APP_ENTRY, {
    ...viewport,
    storage: {
      "settings.language": "en",
      [TTS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        googleCloud: { enabled: true, credentialRef: "google-ref" },
        azure: { enabled: false, credentialRef: "azure-ref", region: "eastus" },
      }),
      [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
      [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
    },
    network: {
      ["POST " + azureUrl]: { status: 200, body: "ID3azure-sample" },
    },
  });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-tts");
  await app.press("id:settings-tts-open-azure");
  await app.waitUntil(() => app.enabled("id:settings-tts-preview"));
  expect(app.requests()).toHaveLength(0);
  await app.press("id:settings-tts-preview");
  await app.waitFor("text:Stop");
  expect(app.requests()).toHaveLength(1);
  const request = app.requests()[0]!;
  expect(request.method).toBe("POST");
  expect(request.url).toBe(azureUrl);
  expect(
    request.headers["ocp-apim-subscription-key"] ?? request.headers["Ocp-Apim-Subscription-Key"],
  ).toBe("azure-key");
  expect(request.body).toContain(TTS_SAMPLE_TEXT);
  expect(request.body).toContain("en-US-JennyNeural");
  expect(app.requests().some((item) => String(item.url).includes("texttospeech"))).toBe(false);
  expect(
    app.audio().some((call) => call.command === "open" && call.src.includes("tts-playback")),
  ).toBe(true);
  const saved = JSON.parse(app.storage()[TTS_STORAGE_KEY]!) as {
    googleCloud: { enabled: boolean };
    azure: { enabled: boolean };
  };
  expect(saved.googleCloud.enabled).toBe(true);
  expect(saved.azure.enabled).toBe(false);
});

test("tts preview: Azure auth and rate limits open no player", async () => {
  const azureUrl = "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1";
  const storage = {
    "settings.language": "en",
    [TTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      googleCloud: { enabled: true, credentialRef: "google-ref" },
      azure: { enabled: false, credentialRef: "azure-ref", region: "eastus" },
    }),
    [ttsCredentialStorageKey("google-ref")]: JSON.stringify({ apiKey: "google-key" }),
    [ttsCredentialStorageKey("azure-ref")]: JSON.stringify({ apiKey: "azure-key" }),
  };
  const auth = await open(APP_ENTRY, {
    ...viewport,
    storage,
    network: {
      ["POST " + azureUrl]: { status: 401, body: "provider secret text" },
    },
  });
  await auth.press("id:nav-settings");
  await auth.press("id:settings-nav-tts");
  await auth.press("id:settings-tts-open-azure");
  await auth.waitUntil(() => auth.enabled("id:settings-tts-preview"));
  await auth.type("id:settings-tts-region", "2");
  expect(auth.enabled("id:settings-tts-preview")).toBe(false);
  await auth.hover("id:settings-tts-preview");
  await auth.waitUntil(() =>
    auth.texts().includes("Save or clear the region before playing the sample."),
  );
  await auth.clear("id:settings-tts-region");
  await auth.type("id:settings-tts-region", "eastus");
  await auth.waitUntil(() => auth.enabled("id:settings-tts-preview"));
  await auth.press("id:settings-tts-preview");
  await auth.waitFor("id:settings-tts-preview-error");
  expect(auth.texts()).toContain("Check the Speech resource key and region.");
  expect(auth.texts()).not.toContain("provider secret text");
  expect(auth.audio()).toEqual([]);
  expect(auth.requests().some((item) => String(item.url).includes("texttospeech"))).toBe(false);

  const limited = await open(APP_ENTRY, {
    ...viewport,
    storage,
    network: {
      ["POST " + azureUrl]: { status: 429, body: "quota exceeded secret" },
    },
  });
  await limited.press("id:nav-settings");
  await limited.press("id:settings-nav-tts");
  await limited.press("id:settings-tts-open-azure");
  await limited.waitUntil(() => limited.enabled("id:settings-tts-preview"));
  await limited.press("id:settings-tts-preview");
  await limited.waitFor("id:settings-tts-preview-error");
  expect(limited.texts()).toContain("Azure is limiting requests. Try again later.");
  expect(limited.texts().join(" ")).not.toMatch(/allowance|quota/i);
  expect(limited.texts()).not.toContain("quota exceeded secret");
  expect(limited.audio()).toEqual([]);

  const loading = await open(APP_ENTRY, {
    ...viewport,
    storage,
    network: {
      ["POST " + azureUrl]: { status: 200, delay: 400, body: "ID3late" },
    },
  });
  await loading.press("id:nav-settings");
  await loading.press("id:settings-nav-tts");
  await loading.press("id:settings-tts-open-azure");
  await loading.waitUntil(() => loading.enabled("id:settings-tts-preview"));
  await loading.press("id:settings-tts-preview");
  await loading.waitFor("text:Cancel");
  await loading.press("id:settings-tts-breadcrumb-root");
  await loading.waitFor("id:settings-tts-card");
  await loading.wait(500);
  expect(loading.audio().some((call) => call.command === "open")).toBe(false);
  expect(loading.texts()).not.toContain("Could not play the sample. Try again.");
  expect(loading.texts()).not.toContain("Check the Speech resource key and region.");
});
