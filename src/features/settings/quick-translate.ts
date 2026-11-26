import { SentenceAlignmentNative } from "langnext-native";
import { platform, signal, Storage } from "nsh";
import { createLogger } from "../../services/log";
import {
  alignmentModel,
  type AlignmentModelDownloadOutcome,
  type AlignmentModelStatus,
} from "../quick-translate/alignment-model";

const log = createLogger("settings/quick-translate");

export const SENTENCE_ALIGNMENT_STORAGE_KEY = "settings.quickTranslate.sentenceAlignment";

export interface SentenceAlignmentStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

export interface SentenceAlignmentModelPort {
  status: () => AlignmentModelStatus;
  ready: () => boolean;
  progress: () => number;
  checkInstalled: () => Promise<boolean>;
  download: () => Promise<AlignmentModelDownloadOutcome>;
  cancel: () => void;
}

export interface CreateSentenceAlignmentControllerOptions {
  model?: SentenceAlignmentModelPort;
  prepareSemanticModel?: () => Promise<boolean>;
  storage?: SentenceAlignmentStorage;
  platformOs?: string;
}

export type SelectSentenceAlignmentResult =
  | "enabled"
  | "disabled"
  | "needs-download"
  | "noop"
  | "failed";

export type ConfirmDownloadAndEnableResult = "enabled" | "cancelled" | "failed";

/** Settings controller coordinating Sentence alignment activation, preparation, and persistence. */
export function createSentenceAlignmentController(
  options: CreateSentenceAlignmentControllerOptions = {},
) {
  const model = options.model ?? alignmentModel;
  const prepareSemanticModel =
    options.prepareSemanticModel ?? (() => SentenceAlignmentNative.prepareSemanticModel());
  const storage = options.storage ?? Storage;
  const platformOs = options.platformOs ?? platform.os;

  const enabled = signal(false);
  const saving = signal(false);
  const saveFailed = signal(false);
  const prepareFailed = signal(false);
  const pendingEnable = signal(false);
  let operationToken = 0;
  let activeSaveToken = 0;
  let startupPending = false;

  async function safePrepare() {
    try {
      return await prepareSemanticModel();
    } catch (error) {
      log.warn("Could not prepare the offline alignment model.", error);
      return false;
    }
  }

  async function clearPersistedPreference(token: number) {
    try {
      await storage.setItem(SENTENCE_ALIGNMENT_STORAGE_KEY, "false");
    } catch (error) {
      log.warn("Could not save the sentence alignment setting.", error);
      if (token === operationToken) {
        saveFailed.set(true);
      }
    }
  }

  async function restoreSavedAlignment(token: number) {
    try {
      const installed = await model.checkInstalled();
      if (token !== operationToken) return;
      if (!installed) {
        await clearPersistedPreference(token);
        return;
      }
      const prepared = await safePrepare();
      if (token !== operationToken) return;
      if (prepared) {
        enabled.set(true);
        return;
      }
      await clearPersistedPreference(token);
    } finally {
      if (token === operationToken) {
        startupPending = false;
      }
    }
  }

  async function activatePreparedModel(token: number): Promise<boolean> {
    const prepared = await safePrepare();
    if (token !== operationToken) return false;
    if (!prepared) {
      log.warn("Could not prepare the offline alignment model.");
      prepareFailed.set(true);
      return false;
    }
    try {
      await storage.setItem(SENTENCE_ALIGNMENT_STORAGE_KEY, "true");
    } catch (error) {
      log.warn("Could not save the sentence alignment setting.", error);
      if (token === operationToken) {
        saveFailed.set(true);
      }
      return false;
    }
    if (token !== operationToken) return false;
    enabled.set(true);
    return true;
  }

  async function loadSentenceAlignment() {
    if (platformOs !== "windows") return;
    const token = ++operationToken;
    startupPending = false;
    enabled.set(false);
    pendingEnable.set(false);
    prepareFailed.set(false);
    saveFailed.set(false);
    let saved = false;
    try {
      saved = (await storage.getItem(SENTENCE_ALIGNMENT_STORAGE_KEY)) === "true";
    } catch (error) {
      log.warn("Could not load the sentence alignment setting.", error);
    }
    if (token !== operationToken) return;
    if (!saved) {
      void model.checkInstalled();
      return;
    }
    startupPending = true;
    void restoreSavedAlignment(token);
  }

  async function selectSentenceAlignment(value: boolean): Promise<SelectSentenceAlignmentResult> {
    if (platformOs !== "windows") return "noop";
    if (!value) {
      if (saving() || pendingEnable() || (!enabled() && !startupPending)) return "noop";
      const token = ++operationToken;
      startupPending = false;
      activeSaveToken = token;
      saveFailed.set(false);
      prepareFailed.set(false);
      saving.set(true);
      try {
        await storage.setItem(SENTENCE_ALIGNMENT_STORAGE_KEY, "false");
        if (token === operationToken) {
          enabled.set(false);
        }
        return "disabled";
      } catch (error) {
        log.warn("Could not save the sentence alignment setting.", error);
        if (token === operationToken) {
          saveFailed.set(true);
        }
        return "failed";
      } finally {
        if (activeSaveToken === token) {
          saving.set(false);
        }
      }
    }

    if (saving() || pendingEnable() || enabled() || model.status() === "downloading") {
      return "noop";
    }
    const token = ++operationToken;
    startupPending = false;
    activeSaveToken = token;
    saveFailed.set(false);
    prepareFailed.set(false);
    saving.set(true);
    try {
      const installed = await model.checkInstalled();
      if (token !== operationToken) return "noop";
      if (!installed) return "needs-download";
      const activated = await activatePreparedModel(token);
      if (token !== operationToken) return "noop";
      return activated ? "enabled" : "failed";
    } finally {
      if (activeSaveToken === token) {
        saving.set(false);
      }
    }
  }

  async function confirmDownloadAndEnable(): Promise<ConfirmDownloadAndEnableResult> {
    if (
      platformOs !== "windows" ||
      saving() ||
      pendingEnable() ||
      enabled() ||
      model.status() === "downloading"
    ) {
      return "cancelled";
    }
    const token = ++operationToken;
    startupPending = false;
    pendingEnable.set(true);
    saveFailed.set(false);
    prepareFailed.set(false);
    try {
      const outcome = await model.download();
      if (token !== operationToken || outcome === "cancelled") {
        if (token === operationToken) {
          pendingEnable.set(false);
        }
        return "cancelled";
      }
      if (outcome === "error") {
        pendingEnable.set(false);
        return "failed";
      }
      activeSaveToken = token;
      saving.set(true);
      const activated = await activatePreparedModel(token);
      if (token !== operationToken) return "cancelled";
      pendingEnable.set(false);
      return activated ? "enabled" : "failed";
    } finally {
      if (token === operationToken) {
        pendingEnable.set(false);
      }
      if (activeSaveToken === token) {
        saving.set(false);
      }
    }
  }

  async function downloadModel(): Promise<AlignmentModelDownloadOutcome> {
    if (platformOs !== "windows") return "cancelled";
    operationToken += 1;
    startupPending = false;
    pendingEnable.set(false);
    prepareFailed.set(false);
    saveFailed.set(false);
    return model.download();
  }

  function cancelDownload() {
    operationToken += 1;
    startupPending = false;
    pendingEnable.set(false);
    prepareFailed.set(false);
    model.cancel();
  }

  return {
    enabled: () => enabled(),
    saving: () => saving(),
    saveFailed: () => saveFailed(),
    prepareFailed: () => prepareFailed(),
    pendingEnable: () => pendingEnable(),
    loadSentenceAlignment,
    selectSentenceAlignment,
    confirmDownloadAndEnable,
    downloadModel,
    cancelDownload,
  };
}

const controller = createSentenceAlignmentController();

export const sentenceAlignmentEnabled = () => controller.enabled();
export const sentenceAlignmentSaving = () => controller.saving();
export const sentenceAlignmentSaveFailed = () => controller.saveFailed();
export const sentenceAlignmentPrepareFailed = () => controller.prepareFailed();
export const sentenceAlignmentPendingEnable = () => controller.pendingEnable();
export const loadSentenceAlignment = () => controller.loadSentenceAlignment();
export const selectSentenceAlignment = (value: boolean) =>
  controller.selectSentenceAlignment(value);
export const confirmDownloadAndEnableSentenceAlignment = () =>
  controller.confirmDownloadAndEnable();
export const downloadAlignmentModel = () => controller.downloadModel();
export const cancelAlignmentModelDownload = () => controller.cancelDownload();
