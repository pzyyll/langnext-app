import { signal } from "nsh";
import { expect, test } from "nsh/test";
import type {
  AlignmentModelDownloadOutcome,
  AlignmentModelStatus,
} from "../quick-translate/alignment-model";
import {
  createSentenceAlignmentController,
  SENTENCE_ALIGNMENT_STORAGE_KEY,
  type SentenceAlignmentModelPort,
  type SentenceAlignmentStorage,
} from "./quick-translate";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, limitMs = 1000) {
  const deadline = Date.now() + limitMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createFixture(
  options: {
    initialStatus?: AlignmentModelStatus;
    installed?: boolean;
    initialStored?: string | null;
  } = {},
) {
  const status = signal<AlignmentModelStatus>(options.initialStatus ?? "missing");
  const progress = signal(0);
  let installed = options.installed ?? false;
  let downloadCalls = 0;
  let cancelCalls = 0;
  let checkCalls = 0;
  let checkGate: Deferred<boolean> | null = null;
  let activeDownload: Deferred<AlignmentModelDownloadOutcome> | null = null;
  const store = new Map<string, string>();
  if (options.initialStored != null) {
    store.set(SENTENCE_ALIGNMENT_STORAGE_KEY, options.initialStored);
  }
  const setCalls: Array<{ key: string; value: string }> = [];
  let setGate: Deferred<void> | null = null;
  let setError: Error | null = null;
  let prepareCalls = 0;
  let prepareGate: Deferred<boolean> | null = null;
  let prepareResult = true;
  let prepareError: Error | null = null;

  const model: SentenceAlignmentModelPort = {
    status: () => status(),
    ready: () => status() === "ready",
    progress: () => progress(),
    checkInstalled: async () => {
      checkCalls += 1;
      const result = checkGate ? await checkGate.promise : installed;
      if (status() !== "downloading") {
        status.set(result ? "ready" : "missing");
      }
      return result;
    },
    download: async () => {
      downloadCalls += 1;
      if (installed) {
        status.set("ready");
        return "ready";
      }
      if (activeDownload) return activeDownload.promise;
      status.set("downloading");
      activeDownload = deferred<AlignmentModelDownloadOutcome>();
      const outcome = await activeDownload.promise;
      activeDownload = null;
      return outcome;
    },
    cancel: () => {
      cancelCalls += 1;
      if (!activeDownload) return;
      const pending = activeDownload;
      activeDownload = null;
      status.set(installed ? "ready" : "missing");
      pending.resolve("cancelled");
    },
  };

  const storage: SentenceAlignmentStorage = {
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      setCalls.push({ key, value });
      if (setGate) await setGate.promise;
      if (setError) throw setError;
      store.set(key, value);
    },
  };

  const controller = createSentenceAlignmentController({
    model,
    storage,
    platformOs: "windows",
    prepareSemanticModel: async () => {
      prepareCalls += 1;
      if (prepareGate) return prepareGate.promise;
      if (prepareError) throw prepareError;
      return prepareResult;
    },
  });

  return {
    controller,
    model,
    storage,
    store,
    setCalls,
    setInstalled: (value: boolean) => {
      installed = value;
    },
    resolveDownload: (outcome: AlignmentModelDownloadOutcome) => {
      if (outcome === "ready") {
        installed = true;
        status.set("ready");
      } else if (outcome === "error") {
        status.set("error");
      } else {
        status.set(installed ? "ready" : "missing");
      }
      const pending = activeDownload;
      activeDownload = null;
      pending?.resolve(outcome);
    },
    setSetGate: (gate: Deferred<void> | null) => {
      setGate = gate;
    },
    setCheckGate: (gate: Deferred<boolean> | null) => {
      checkGate = gate;
    },
    setSetError: (error: Error | null) => {
      setError = error;
    },
    setPrepareGate: (gate: Deferred<boolean> | null) => {
      prepareGate = gate;
    },
    setPrepareResult: (value: boolean) => {
      prepareResult = value;
    },
    setPrepareError: (error: Error | null) => {
      prepareError = error;
    },
    counts: () => ({ downloadCalls, cancelCalls, checkCalls, prepareCalls }),
  };
}

test("alignment activation: asks before downloading and waits for preparation and storage write", async () => {
  const fixture = createFixture({ installed: false });

  expect(await fixture.controller.selectSentenceAlignment(true)).toBe("needs-download");
  expect(fixture.counts().downloadCalls).toBe(0);
  expect(fixture.store.has(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe(false);
  expect(fixture.setCalls).toHaveLength(0);
  expect(fixture.controller.enabled()).toBe(false);

  const prepareGate = deferred<boolean>();
  const storageGate = deferred<void>();
  fixture.setPrepareGate(prepareGate);
  fixture.setSetGate(storageGate);

  const confirmPromise = fixture.controller.confirmDownloadAndEnable();
  expect(fixture.counts().downloadCalls).toBe(1);
  expect(fixture.controller.pendingEnable()).toBe(true);
  expect(fixture.controller.enabled()).toBe(false);

  fixture.resolveDownload("ready");
  await waitUntil(() => fixture.counts().prepareCalls === 1);

  expect(fixture.model.status()).toBe("ready");
  expect(fixture.counts().prepareCalls).toBe(1);
  expect(fixture.controller.enabled()).toBe(false);
  expect(fixture.setCalls).toHaveLength(0);

  prepareGate.resolve(true);
  await waitUntil(() => fixture.setCalls.length === 1);

  expect(fixture.setCalls).toEqual([{ key: SENTENCE_ALIGNMENT_STORAGE_KEY, value: "true" }]);
  expect(fixture.controller.enabled()).toBe(false);

  storageGate.resolve();
  expect(await confirmPromise).toBe("enabled");
  expect(fixture.controller.enabled()).toBe(true);
  expect(fixture.controller.pendingEnable()).toBe(false);
  expect(fixture.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("true");
});

test("alignment activation: manual download and retry never inherit pending enable intent", async () => {
  const fixture = createFixture({ installed: false });

  const manual = fixture.controller.downloadModel();
  expect(fixture.controller.pendingEnable()).toBe(false);
  expect(fixture.controller.enabled()).toBe(false);
  fixture.resolveDownload("ready");
  expect(await manual).toBe("ready");
  expect(fixture.controller.enabled()).toBe(false);
  expect(fixture.counts().prepareCalls).toBe(0);
  expect(fixture.store.has(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe(false);

  const retryFixture = createFixture({ installed: false });
  const failedConfirm = retryFixture.controller.confirmDownloadAndEnable();
  expect(retryFixture.controller.pendingEnable()).toBe(true);
  retryFixture.resolveDownload("error");
  expect(await failedConfirm).toBe("failed");
  expect(retryFixture.controller.pendingEnable()).toBe(false);
  expect(retryFixture.controller.enabled()).toBe(false);

  const retryDownload = retryFixture.controller.downloadModel();
  expect(retryFixture.controller.pendingEnable()).toBe(false);
  retryFixture.resolveDownload("ready");
  expect(await retryDownload).toBe("ready");
  expect(retryFixture.controller.enabled()).toBe(false);
  expect(retryFixture.counts().prepareCalls).toBe(0);
  expect(retryFixture.store.has(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe(false);
});

test("alignment activation: cancel discards late completion and never leaves switch enabled", async () => {
  const fixture = createFixture({ installed: false });
  const prepareGate = deferred<boolean>();
  fixture.setPrepareGate(prepareGate);

  const confirmPromise = fixture.controller.confirmDownloadAndEnable();
  expect(fixture.controller.pendingEnable()).toBe(true);

  fixture.resolveDownload("ready");
  await waitUntil(() => fixture.counts().prepareCalls === 1);
  expect(fixture.counts().prepareCalls).toBe(1);

  fixture.controller.cancelDownload();
  expect(fixture.controller.pendingEnable()).toBe(false);
  expect(fixture.controller.enabled()).toBe(false);

  prepareGate.resolve(true);
  expect(await confirmPromise).toBe("cancelled");
  expect(fixture.controller.enabled()).toBe(false);
  expect(fixture.setCalls).toHaveLength(0);

  const downloadCancelFixture = createFixture({ installed: false });
  const pendingTransfer = downloadCancelFixture.controller.confirmDownloadAndEnable();
  expect(downloadCancelFixture.controller.pendingEnable()).toBe(true);
  downloadCancelFixture.controller.cancelDownload();
  expect(await pendingTransfer).toBe("cancelled");
  expect(downloadCancelFixture.controller.pendingEnable()).toBe(false);
  expect(downloadCancelFixture.controller.enabled()).toBe(false);
  expect(downloadCancelFixture.counts().cancelCalls).toBe(1);
});

test("alignment activation: preparation failure keeps verified files and storage failure keeps switch off", async () => {
  const prepareFail = createFixture({ installed: false });
  prepareFail.setPrepareResult(false);

  const confirmPrepareFail = prepareFail.controller.confirmDownloadAndEnable();
  prepareFail.resolveDownload("ready");
  expect(await confirmPrepareFail).toBe("failed");
  expect(prepareFail.model.status()).toBe("ready");
  expect(prepareFail.controller.enabled()).toBe(false);
  expect(prepareFail.controller.pendingEnable()).toBe(false);
  expect(prepareFail.controller.prepareFailed()).toBe(true);
  expect(prepareFail.setCalls).toHaveLength(0);

  const saveFail = createFixture({ installed: true, initialStatus: "ready" });
  saveFail.setSetError(new Error("disk full"));
  expect(await saveFail.controller.selectSentenceAlignment(true)).toBe("failed");
  expect(saveFail.controller.enabled()).toBe(false);
  expect(saveFail.controller.saveFailed()).toBe(true);
  expect(saveFail.controller.prepareFailed()).toBe(false);
  expect(saveFail.store.has(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe(false);

  const turnOffFixture = createFixture({
    installed: true,
    initialStatus: "ready",
    initialStored: "false",
  });
  expect(await turnOffFixture.controller.selectSentenceAlignment(true)).toBe("enabled");
  expect(turnOffFixture.controller.enabled()).toBe(true);
  expect(await turnOffFixture.controller.selectSentenceAlignment(false)).toBe("disabled");
  expect(turnOffFixture.controller.enabled()).toBe(false);
  expect(turnOffFixture.counts().cancelCalls).toBe(0);
  expect(turnOffFixture.model.status()).toBe("ready");
  expect(turnOffFixture.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("false");
});

test("alignment startup: missing assets stay off without blocking launch and clear stored preference", async () => {
  const fixture = createFixture({
    initialStatus: "checking",
    installed: false,
    initialStored: "true",
  });
  const checkGate = deferred<boolean>();
  fixture.setCheckGate(checkGate);

  await fixture.controller.loadSentenceAlignment();
  expect(fixture.controller.enabled()).toBe(false);
  expect(fixture.controller.pendingEnable()).toBe(false);
  expect(fixture.counts().downloadCalls).toBe(0);

  await waitUntil(() => fixture.counts().checkCalls === 1);
  expect(fixture.counts().downloadCalls).toBe(0);
  expect(fixture.counts().prepareCalls).toBe(0);
  expect(fixture.controller.enabled()).toBe(false);

  checkGate.resolve(false);
  await waitUntil(() => fixture.setCalls.length === 1);

  expect(fixture.controller.enabled()).toBe(false);
  expect(fixture.controller.pendingEnable()).toBe(false);
  expect(fixture.counts().downloadCalls).toBe(0);
  expect(fixture.counts().prepareCalls).toBe(0);
  expect(fixture.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("false");
});

test("alignment startup: valid model restores enabled offline and failed startup prepare or cleanup behaves safely", async () => {
  const valid = createFixture({
    initialStatus: "checking",
    installed: true,
    initialStored: "true",
  });
  await valid.controller.loadSentenceAlignment();
  await waitUntil(() => valid.controller.enabled());
  expect(valid.counts().downloadCalls).toBe(0);
  expect(valid.counts().prepareCalls).toBe(1);
  expect(valid.controller.pendingEnable()).toBe(false);
  expect(valid.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("true");
  expect(valid.setCalls).toHaveLength(0);

  const prepareFail = createFixture({
    initialStatus: "checking",
    installed: true,
    initialStored: "true",
  });
  prepareFail.setPrepareResult(false);
  await prepareFail.controller.loadSentenceAlignment();
  await waitUntil(() => prepareFail.setCalls.length === 1);
  expect(prepareFail.controller.enabled()).toBe(false);
  expect(prepareFail.counts().downloadCalls).toBe(0);
  expect(prepareFail.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("false");

  const saveFail = createFixture({
    initialStatus: "checking",
    installed: false,
    initialStored: "true",
  });
  saveFail.setSetError(new Error("read only"));
  await saveFail.controller.loadSentenceAlignment();
  await waitUntil(() => saveFail.controller.saveFailed());
  expect(saveFail.controller.enabled()).toBe(false);
  expect(saveFail.counts().downloadCalls).toBe(0);
});

test("alignment startup: explicit choice discards late startup restore and never restores pending intent", async () => {
  const disableRace = createFixture({
    initialStatus: "checking",
    installed: true,
    initialStored: "true",
  });
  const prepareGate = deferred<boolean>();
  disableRace.setPrepareGate(prepareGate);

  await disableRace.controller.loadSentenceAlignment();
  await waitUntil(() => disableRace.counts().prepareCalls === 1);
  expect(disableRace.controller.enabled()).toBe(false);

  expect(await disableRace.controller.selectSentenceAlignment(false)).toBe("disabled");
  expect(disableRace.controller.enabled()).toBe(false);
  expect(disableRace.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("false");

  prepareGate.resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(disableRace.controller.enabled()).toBe(false);
  expect(disableRace.store.get(SENTENCE_ALIGNMENT_STORAGE_KEY)).toBe("false");

  const downloadRace = createFixture({
    initialStatus: "checking",
    installed: false,
    initialStored: "true",
  });
  const checkGate = deferred<boolean>();
  downloadRace.setCheckGate(checkGate);

  await downloadRace.controller.loadSentenceAlignment();
  await waitUntil(() => downloadRace.counts().checkCalls === 1);
  const manual = downloadRace.controller.downloadModel();
  expect(downloadRace.controller.pendingEnable()).toBe(false);

  checkGate.resolve(true);
  downloadRace.resolveDownload("ready");
  expect(await manual).toBe("ready");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(downloadRace.counts().prepareCalls).toBe(0);
  expect(downloadRace.controller.enabled()).toBe(false);
});
