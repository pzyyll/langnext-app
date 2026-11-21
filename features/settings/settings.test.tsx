import { expect, open, test } from "nsh/test";
import { SPLIT_RAIL_STORAGE_KEYS } from "../../components/layout/split-rail";
import { LANGUAGE_DETECTION_STORAGE_KEY } from "../language-detection/settings";
import { makeChannel, makeModel, makeSeedStorage } from "../models/__tests__/fixtures";
import { baiduCredentialStorageKey, OCR_STORAGE_KEY } from "../ocr/settings";

const APP_ENTRY = "../../App.tsx";
const viewport = { width: 1040, height: 720, platform: "windows" as const };

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

  // General is active by default and displays Language only.
  expect(app.shows("id:settings-general-card")).toBe(true);
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
  expect(app.texts()).toContain("透明标题栏与侧边栏");
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
  expect(winApp.texts().some((text) => text.includes("enabled presets"))).toBe(true);

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

test("language detection: saves and restores the ordered detector chain and language preferences", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
      makeModel({ id: "m-2", providerId: "ch-openai", modelKey: "gpt-4.1", enabled: true }),
      makeModel({ id: "m-3", providerId: "ch-openai", modelKey: "gpt-4o", enabled: true }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.waitFor("id:settings-nav-language-detection");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");

  // Off is the initial mode and hides the detection model controls.
  expect(app.shows("id:settings-detection-mode")).toBe(true);
  expect(app.texts()).toContain("Off");
  expect(app.shows("id:settings-detection-primary")).toBe(false);
  expect(app.shows("id:settings-detection-add-backup")).toBe(false);
  expect(app.texts().some((line) => line.includes("text sample"))).toBe(false);
  expect(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-detection-mode");
  await app.waitFor("role:option[AI]");
  await app.press("role:option[AI]");
  await app.waitFor("id:settings-detection-primary");
  expect(app.enabled("id:settings-detection-add-backup")).toBe(false);
  await app.press("id:settings-detection-save");
  await app.waitFor("id:settings-detection-error");
  expect(app.texts()).toContain("Choose a primary detection model.");
  expect(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-detection-primary");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("role:option[OpenAI Main · gpt-4.1-mini]");

  expect(app.enabled("id:settings-detection-add-backup")).toBe(true);
  await app.press("id:settings-detection-add-backup");
  await app.press("id:settings-detection-backup-0");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  await app.press("role:option[OpenAI Main · gpt-4.1]");

  await app.press("id:settings-detection-add-backup");
  await app.press("id:settings-detection-backup-1");
  await app.waitFor("role:option[OpenAI Main · gpt-4o]");
  await app.press("role:option[OpenAI Main · gpt-4o]");

  await app.press("id:settings-detection-backup-up-1");

  await app.press("id:settings-detection-native-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");
  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[English]");
  await app.press("role:option[English]");

  await app.press("id:settings-detection-save");
  await app.waitUntil(() => Boolean(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]));
  expect(app.requests()).toHaveLength(0);

  const stored = JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!);
  expect(stored).toMatchObject({
    version: 1,
    mode: "ai",
    modelIds: ["m-1", "m-3", "m-2"],
    nativeLanguage: "zh",
    preferredTranslationLanguage: "en",
  });

  // The interface language preference is untouched by saving detection settings.
  expect(app.storage()["settings.language"]).toBe("en");
  await app.press("id:settings-nav-general");
  await app.waitFor("id:settings-general-card");
  expect(app.shows("id:settings-detection-card")).toBe(false);

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-card");
  expect(reopened.shows("id:settings-detection-primary")).toBe(true);
  expect(reopened.shows("id:settings-detection-backup-row-1")).toBe(true);
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1-mini");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4o");
  expect(reopened.texts()).toContain("OpenAI Main · gpt-4.1");
  expect(reopened.requests()).toHaveLength(0);
});

test("language detection: saves Google detection without model configuration", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");

  await app.press("id:settings-detection-mode");
  await app.waitFor("role:option[Google]");
  await app.press("role:option[Google]");
  await app.waitUntil(() => app.texts().includes("Google"));
  expect(app.shows("id:settings-detection-primary")).toBe(false);
  expect(app.shows("id:settings-detection-add-backup")).toBe(false);

  await app.press("id:settings-detection-native-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");
  await app.press("id:settings-detection-save");
  await app.waitUntil(() => Boolean(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]));

  const stored = JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!);
  expect(stored).toMatchObject({ version: 1, mode: "google", modelIds: [], nativeLanguage: "zh" });
  expect(app.requests()).toHaveLength(0);

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-language-detection");
  await reopened.waitFor("id:settings-detection-mode");
  await reopened.waitUntil(() => reopened.texts().includes("Google"));
  expect(reopened.shows("id:settings-detection-primary")).toBe(false);
  expect(reopened.requests()).toHaveLength(0);
});

test("language detection: keeps unavailable saved models and offers Models recovery", async () => {
  const savedSettings = JSON.stringify({
    version: 1,
    mode: "ai",
    modelIds: ["m-removed"],
    nativeLanguage: "zh",
    preferredTranslationLanguage: null,
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
  await app.waitFor("id:settings-detection-primary-unavailable");
  expect(app.shows("id:settings-detection-manage-models")).toBe(true);
  expect(app.texts()).toContain("Model no longer exists in Models.");

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
  await emptyCatalog.waitFor("id:settings-detection-models-recovery");
  expect(emptyCatalog.shows("id:settings-detection-primary-unavailable")).toBe(true);
  await emptyCatalog.press("id:settings-detection-manage-models");
  await emptyCatalog.waitFor("id:models-page");
});

test("language detection: keeps the draft and shows a localized alert when validation fails", async () => {
  const seed = makeSeedStorage({
    channels: [makeChannel({ id: "ch-openai", displayName: "OpenAI Main", enabled: true })],
    models: [
      makeModel({ id: "m-1", providerId: "ch-openai", modelKey: "gpt-4.1-mini", enabled: true }),
    ],
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.press("id:settings-detection-mode");
  await app.waitFor("role:option[AI]");
  await app.press("role:option[AI]");
  await app.press("id:settings-detection-primary");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("role:option[OpenAI Main · gpt-4.1-mini]");
  await app.press("id:settings-detection-native-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");
  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[Chinese]");
  await app.press("role:option[Chinese]");

  await app.press("id:settings-detection-save");
  await app.waitFor("id:settings-detection-error");
  expect(app.texts()).toContain(
    "The native language and the preferred translation language must differ.",
  );
  expect(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]).toBeUndefined();
  expect(app.shows("id:settings-detection-primary")).toBe(true);

  await app.press("id:settings-detection-preferred-language");
  await app.waitFor("role:option[English]");
  await app.press("role:option[English]");
  await app.press("id:settings-detection-save");
  await app.waitUntil(() => Boolean(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]));
  expect(JSON.parse(app.storage()[LANGUAGE_DETECTION_STORAGE_KEY]!).modelIds).toEqual(["m-1"]);
});

test("language detection: localizes labels and help text in both languages", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: { "settings.language": "en" } });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.texts()).toContain("Language Detection");
  expect(app.texts()).toContain("Off");
  expect(app.texts()).toContain("Native language");
  expect(app.texts()).toContain("Translate my native language into");
  expect(app.texts()).toContain(
    "When the target is set to Automatic, text in other languages is translated into your native language. Text in your native language is translated into the language selected above.",
  );

  // The detector list carries every mode, with the saved one selected.
  await app.press("id:settings-detection-mode");
  await app.waitFor("role:option[Google]");
  expect(app.texts()).toContain("AI");
  await app.press("role:option[Off]");

  await app.press("id:settings-nav-general");
  await app.press("id:language-zh-CN");
  await app.press("id:settings-nav-language-detection");
  await app.waitFor("id:settings-detection-card");
  expect(app.texts()).toContain("语言检测");
  expect(app.texts()).toContain("关闭");
  expect(app.texts()).toContain("母语");
  expect(app.texts()).toContain("母语译为");
  expect(app.texts()).toContain("目标语言设为自动时，非母语译为母语，母语译为上方指定的语言。");
});

test("ocr settings: saves and restores the image-capable model", async () => {
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

  expect(app.shows("id:settings-ocr-service")).toBe(true);
  expect(app.texts()).toContain("AI OCR");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  expect(app.storage()[OCR_STORAGE_KEY]).toBeUndefined();

  await app.press("id:settings-ocr-service");
  await app.press("role:option[AI OCR]");
  await app.press("id:settings-ocr-model");
  await app.waitFor("role:option[OpenAI Main · gpt-4.1]");
  expect(app.texts()).not.toContain("OpenAI Main · gpt-4.1-mini");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.waitFor("id:settings-ocr-save");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);

  await app.press("id:settings-ocr-save");
  await app.waitUntil(() => Boolean(app.storage()[OCR_STORAGE_KEY]));
  expect(JSON.parse(app.storage()[OCR_STORAGE_KEY]!)).toEqual({
    version: 1,
    kind: "ai",
    modelId: "m-vision",
  });
  expect(app.requests()).toHaveLength(0);

  // Leaving the category and returning keeps the saved choice.
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
  expect(reopened.shows("id:settings-ocr-model-unavailable")).toBe(false);
  expect(reopened.requests()).toHaveLength(0);

  expect(reopened.shows("id:settings-ocr-windows-only")).toBe(false);

  // Both locales carry the service, model, and privacy copy.
  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("OCR 服务");
  expect(reopened.texts()).toContain("模型");
  expect(reopened.texts()).toContain("所选区域会发送给该模型。");
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
      [OCR_STORAGE_KEY]: JSON.stringify({ version: 1, kind: "ai", modelId: "m-removed" }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
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
        [OCR_STORAGE_KEY]: JSON.stringify({ version: 1, kind: "ai", modelId: "m-vision" }),
      },
    }),
  });
  await lostImage.press("id:nav-settings");
  await lostImage.press("id:settings-nav-ocr");
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
      [OCR_STORAGE_KEY]: JSON.stringify({ version: 1, kind: "ai", modelId: "m-vision" }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: seed });

  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
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
        [OCR_STORAGE_KEY]: JSON.stringify({ version: 1, kind: "ai", modelId: "m-vision" }),
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
  await failingWrite.waitFor("id:settings-ocr-card");
  await failingWrite.press("id:settings-ocr-model");
  await failingWrite.waitFor("role:option[OpenAI Main · gpt-4o]");
  await failingWrite.press("role:option[OpenAI Main · gpt-4o]");
  await failingWrite.press("id:settings-ocr-save");
  await failingWrite.waitFor("id:settings-ocr-error");
  expect(failingWrite.texts()).toContain(
    "Could not save the OCR settings. Check storage and try again.",
  );
  expect(failingWrite.texts()).toContain("OpenAI Main · gpt-4o");
  expect(JSON.parse(failingWrite.storage()[OCR_STORAGE_KEY]!).modelId).toBe("m-vision");
});

test("ocr settings: saves Baidu keys and restores a blank form", async () => {
  const app = await open(APP_ENTRY, { ...viewport, storage: makeSeedStorage({}) });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
  await app.waitFor("id:settings-ocr-card");

  await app.press("id:settings-ocr-service");
  await app.waitFor("role:option[Baidu OCR]");
  await app.press("role:option[Baidu OCR]");

  expect(app.texts()).toContain("Accurate with Location");
  expect(app.shows("id:settings-ocr-model")).toBe(false);
  expect(app.shows("id:settings-ocr-models-recovery")).toBe(false);
  expect(app.shows("id:settings-ocr-manage-models")).toBe(false);
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  expect(app.texts()).toContain("The selected area is sent to Baidu.");

  await app.type("id:settings-ocr-baidu-api-key", "synthetic-api-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  await app.type("id:settings-ocr-baidu-secret-key", "synthetic-secret-key");
  expect(app.enabled("id:settings-ocr-save")).toBe(true);

  await app.press("id:settings-ocr-save");
  await app.waitUntil(() => Boolean(app.storage()[OCR_STORAGE_KEY]));
  const saved = JSON.parse(app.storage()[OCR_STORAGE_KEY]!) as {
    version: number;
    kind: string;
    operation: string;
    credentialRef: string;
  };
  expect(saved.version).toBe(1);
  expect(saved.kind).toBe("baidu");
  expect(saved.operation).toBe("accurate");
  expect(JSON.stringify(saved).includes("synthetic")).toBe(false);
  expect(JSON.parse(app.storage()[baiduCredentialStorageKey(saved.credentialRef)]!)).toEqual({
    apiKey: "synthetic-api-key",
    secretKey: "synthetic-secret-key",
  });
  expect(app.value("id:settings-ocr-baidu-api-key")).toBe("");
  expect(app.value("id:settings-ocr-baidu-secret-key")).toBe("");
  expect(app.requests()).toHaveLength(0);

  const reopened = await open(APP_ENTRY, { ...viewport, storage: app.storage() });
  await reopened.press("id:nav-settings");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("Baidu OCR");
  expect(reopened.texts()).toContain("Accurate with Location");
  expect(reopened.value("id:settings-ocr-baidu-api-key")).toBe("");
  expect(reopened.value("id:settings-ocr-baidu-secret-key")).toBe("");
  expect(reopened.requests()).toHaveLength(0);

  await reopened.press("id:settings-nav-general");
  await reopened.press("id:language-zh-CN");
  await reopened.press("id:settings-nav-ocr");
  await reopened.waitFor("id:settings-ocr-card");
  expect(reopened.texts()).toContain("百度 OCR");
  expect(reopened.texts()).toContain("模式");
  expect(reopened.texts()).toContain("高精度含位置版");
  expect(reopened.texts()).toContain("所选区域会发送给百度。");
});

test("ocr settings: a Baidu draft does not change keys until a successful save", async () => {
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
      [OCR_STORAGE_KEY]: JSON.stringify({
        version: 1,
        kind: "baidu",
        operation: "accurate",
        credentialRef: ref,
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
  await app.waitUntil(() =>
    app
      .texts()
      .includes("Leave both fields blank to keep the saved keys. Enter both to replace them."),
  );
  expect(app.value("id:settings-ocr-baidu-api-key")).toBe("");
  expect(app.value("id:settings-ocr-baidu-secret-key")).toBe("");

  await app.press("id:settings-ocr-service");
  await app.press("role:option[AI OCR]");
  expect(app.texts()).toContain("Saving AI OCR removes the saved Baidu keys.");
  expect(app.storage()[baiduCredentialStorageKey(ref)]).toBe(
    JSON.stringify({ apiKey: "saved-api-key", secretKey: "saved-secret-key" }),
  );
  expect(JSON.parse(app.storage()[OCR_STORAGE_KEY]!).kind).toBe("baidu");

  await app.press("id:settings-ocr-service");
  await app.press("role:option[Baidu OCR]");
  await app.type("id:settings-ocr-baidu-api-key", "only-one");
  expect(app.enabled("id:settings-ocr-save")).toBe(false);
  expect(JSON.parse(app.storage()[baiduCredentialStorageKey(ref)]!).apiKey).toBe("saved-api-key");

  await app.press("id:settings-ocr-service");
  await app.press("role:option[AI OCR]");
  await app.press("id:settings-ocr-model");
  await app.press("role:option[OpenAI Main · gpt-4.1]");
  await app.press("id:settings-ocr-save");
  await app.waitUntil(() => JSON.parse(app.storage()[OCR_STORAGE_KEY]!).kind === "ai");
  expect(app.storage()[baiduCredentialStorageKey(ref)]).toBeUndefined();
  expect(app.requests()).toHaveLength(0);
});

test("ocr settings: unreadable Baidu keys and a failed write leave the binding", async () => {
  const ref = "broken-baidu-ref";
  const broken = makeSeedStorage({
    extra: {
      [OCR_STORAGE_KEY]: JSON.stringify({
        version: 1,
        kind: "baidu",
        operation: "general",
        credentialRef: ref,
      }),
      [baiduCredentialStorageKey(ref)]: JSON.stringify({ apiKey: 1 }),
    },
  });
  const app = await open(APP_ENTRY, { ...viewport, storage: broken });
  await app.press("id:nav-settings");
  await app.press("id:settings-nav-ocr");
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
  await failing.waitFor("id:settings-ocr-baidu-keys-missing");
  await failing.type("id:settings-ocr-baidu-api-key", "replacement-api-key");
  await failing.type("id:settings-ocr-baidu-secret-key", "replacement-secret-key");
  await failing.press("id:settings-ocr-save");
  await failing.waitFor("id:settings-ocr-error");
  expect(JSON.parse(failing.storage()[OCR_STORAGE_KEY]!).credentialRef).toBe(ref);
  expect(failing.value("id:settings-ocr-baidu-api-key")).toBe("replacement-api-key");
  expect(failing.value("id:settings-ocr-baidu-secret-key")).toBe("replacement-secret-key");
  expect(failing.requests()).toHaveLength(0);
});
