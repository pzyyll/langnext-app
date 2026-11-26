import type { SemanticModelAsset } from "langnext-native";
import { expect, test } from "nsh/test";
import type { FetchLike } from "../../services/http";
import { createAlignmentModel, type AlignmentModelNative } from "./alignment-model";

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

function makeModelFixture(
  options: {
    assets?: SemanticModelAsset[];
    initiallyInstalled?: ReadonlyArray<number>;
    failVerifyId?: number;
  } = {},
) {
  const assets: SemanticModelAsset[] = options.assets ?? [
    { id: 0, bytes: 4, url: "https://models.example.test/config.json" },
    { id: 1, bytes: 6, url: "https://models.example.test/model.onnx" },
  ];
  const installed = new Set<number>(options.initiallyInstalled ?? []);
  const temp = new Map<number, Uint8Array>();
  const finishGates = new Map<number, Deferred<void>>();
  let cleanGate: Deferred<void> | null = null;
  let cleanCalls = 0;

  const native: AlignmentModelNative = {
    modelAssets: () => assets,
    modelReady: async () => assets.every((asset) => installed.has(asset.id)),
    appendModelChunk: async (id, offset, chunk) => {
      const existing = temp.get(id) ?? new Uint8Array(0);
      if (existing.length !== offset) throw new Error(`Offset mismatch for ${id}`);
      const next = new Uint8Array(existing.length + chunk.length);
      next.set(existing, 0);
      next.set(chunk, existing.length);
      temp.set(id, next);
    },
    finishModelAsset: async (id) => {
      const gate = finishGates.get(id);
      if (gate) await gate.promise;
      if (options.failVerifyId === id) throw new Error(`Checksum mismatch for ${id}`);
      const asset = assets.find((item) => item.id === id);
      const data = temp.get(id);
      if (!asset || !data || data.length !== asset.bytes) {
        throw new Error(`Incomplete asset ${id}`);
      }
      temp.delete(id);
      installed.add(id);
    },
    cleanModelDownload: async () => {
      cleanCalls += 1;
      temp.clear();
      if (cleanGate) await cleanGate.promise;
    },
  };

  return {
    assets,
    installed,
    temp,
    finishGates,
    setCleanGate: (gate: Deferred<void> | null) => {
      cleanGate = gate;
    },
    cleanCalls: () => cleanCalls,
    native,
  };
}

test("alignment download: checks local status offline and shares one verified transfer", async () => {
  const fixture = makeModelFixture();
  const requests: string[] = [];
  const firstChunk = deferred<void>();
  const finishLast = deferred<void>();
  fixture.finishGates.set(1, finishLast);

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push(`${init.method} ${url}`);
    if (url === fixture.assets[0]!.url) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
            controller.close();
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(Uint8Array.from([5, 6, 7]));
          await firstChunk.promise;
          controller.enqueue(Uint8Array.from([8, 9, 10]));
          controller.close();
        },
      }),
    };
  };

  const model = createAlignmentModel({
    native: fixture.native,
    fetchImpl,
    platformOs: "windows",
  });

  expect(await model.checkInstalled()).toBe(false);
  expect(model.status()).toBe("missing");
  expect(model.ready()).toBe(false);
  expect(requests).toEqual([]);

  const first = model.download();
  const second = model.download();

  await waitUntil(() => model.status() === "downloading" && model.progress() > 0);
  expect(model.status()).toBe("downloading");
  expect(model.progress()).toBeGreaterThan(0);
  expect(model.progress()).toBeLessThan(100);
  expect(requests).toEqual([
    "GET https://models.example.test/config.json",
    "GET https://models.example.test/model.onnx",
  ]);

  let settledBeforeVerify = false;
  void first.then(() => {
    settledBeforeVerify = true;
  });
  firstChunk.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settledBeforeVerify).toBe(false);
  expect(model.ready()).toBe(false);

  finishLast.resolve();
  expect(await first).toBe("ready");
  expect(await second).toBe("ready");
  expect(model.status()).toBe("ready");
  expect(model.ready()).toBe(true);
  expect(requests).toHaveLength(2);

  // Already-installed files return ready with no extra requests.
  expect(await model.download()).toBe("ready");
  expect(requests).toHaveLength(2);
});

test("alignment download: cancel aborts the stream, drops temp data, and settles before another request begins", async () => {
  const fixture = makeModelFixture();
  const cleanGate = deferred<void>();
  fixture.setCleanGate(cleanGate);

  const requests: string[] = [];
  let abortedSignals = 0;
  let streamCancelled = 0;
  let attempt = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push(`${init.method} ${url}`);
    if (url === fixture.assets[0]!.url) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
            controller.close();
          },
        }),
      };
    }

    attempt += 1;
    const currentAttempt = attempt;
    if (currentAttempt === 1) {
      init.signal.addEventListener("abort", () => {
        abortedSignals += 1;
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([5, 6]));
          },
          cancel() {
            streamCancelled += 1;
          },
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([5, 6, 7, 8, 9, 10]));
          controller.close();
        },
      }),
    };
  };

  const model = createAlignmentModel({
    native: fixture.native,
    fetchImpl,
    platformOs: "windows",
  });

  const first = model.download();
  let firstSettled = false;
  void first.then(() => {
    firstSettled = true;
  });

  await waitUntil(() => model.status() === "downloading" && fixture.temp.has(1));
  expect(fixture.installed.has(0)).toBe(true);

  model.cancel();
  const second = model.download();

  await waitUntil(() => abortedSignals === 1 && streamCancelled === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(firstSettled).toBe(false);
  expect(requests).toHaveLength(2);
  expect(fixture.temp.size).toBe(0);

  fixture.setCleanGate(null);
  cleanGate.resolve();

  expect(await first).toBe("cancelled");
  expect(await second).toBe("ready");
  expect(requests).toHaveLength(4);
  expect(model.status()).toBe("ready");
});

test("alignment download: failed verification never reports ready and recheck keeps verified files after cancel", async () => {
  const failing = makeModelFixture({ failVerifyId: 1 });
  const failingFetch: FetchLike = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          url === failing.assets[0]!.url
            ? Uint8Array.from([1, 2, 3, 4])
            : Uint8Array.from([5, 6, 7, 8, 9, 10]),
        );
        controller.close();
      },
    }),
  });

  const failingModel = createAlignmentModel({
    native: failing.native,
    fetchImpl: failingFetch,
    platformOs: "windows",
  });

  expect(await failingModel.download()).toBe("error");
  expect(failingModel.status()).toBe("error");
  expect(failingModel.ready()).toBe(false);
  expect(failing.cleanCalls()).toBe(1);
  expect(failing.temp.size).toBe(0);
  expect(await failingModel.checkInstalled()).toBe(false);
  expect(failingModel.status()).toBe("missing");

  const partial = makeModelFixture();
  const partialRequests: string[] = [];
  const partialFetch: FetchLike = async (url) => {
    partialRequests.push(url);
    if (url === partial.assets[0]!.url) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
            controller.close();
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([5, 6]));
        },
      }),
    };
  };

  const partialModel = createAlignmentModel({
    native: partial.native,
    fetchImpl: partialFetch,
    platformOs: "windows",
  });
  const pending = partialModel.download();
  await waitUntil(() => partial.installed.has(0) && partial.temp.has(1));
  partialModel.cancel();

  expect(await pending).toBe("cancelled");
  expect(partial.installed.has(0)).toBe(true);
  expect(partial.temp.size).toBe(0);
  expect(partialModel.status()).toBe("missing");
  expect(partialModel.ready()).toBe(false);

  const requestsBeforeRecheck = partialRequests.length;
  expect(await partialModel.checkInstalled()).toBe(false);
  expect(partialModel.status()).toBe("missing");
  expect(partialRequests.length).toBe(requestsBeforeRecheck);
});
