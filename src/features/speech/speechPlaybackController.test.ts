// ABOUTME: Unit tests for the injectable Speech playback controller state machine.
// ABOUTME: Covers replacement, cancellation, URL revocation, and stale completion suppression.
import { describe, expect, mock, test } from "bun:test";
import {
  createSpeechPlaybackController,
  type SpeechAudioAdapter,
  type SpeechPlaybackSnapshot,
  type SpeechUrlAdapter,
} from "./speechPlaybackController";

function createMockAudio(): SpeechAudioAdapter & {
  endedHandler: (() => void) | null;
  errorHandler: (() => void) | null;
  src: string | null;
  playCalls: number;
  pauseCalls: number;
  playImpl: () => Promise<void>;
} {
  const audio = {
    endedHandler: null as (() => void) | null,
    errorHandler: null as (() => void) | null,
    src: null as string | null,
    playCalls: 0,
    pauseCalls: 0,
    playImpl: async () => undefined,
    pause() {
      audio.pauseCalls += 1;
    },
    async play() {
      audio.playCalls += 1;
      return audio.playImpl();
    },
    setSrc(url: string) {
      audio.src = url;
    },
    clearSrc() {
      audio.src = null;
    },
    setOnEnded(handler: (() => void) | null) {
      audio.endedHandler = handler;
    },
    setOnError(handler: (() => void) | null) {
      audio.errorHandler = handler;
    },
  };
  return audio;
}

function createMockUrls(): SpeechUrlAdapter & {
  created: string[];
  revoked: string[];
} {
  let counter = 0;
  const urls = {
    created: [] as string[],
    revoked: [] as string[],
    createObjectURL() {
      counter += 1;
      const url = `blob:mock-${counter}`;
      urls.created.push(url);
      return url;
    },
    revokeObjectURL(url: string) {
      urls.revoked.push(url);
    },
  };
  return urls;
}

describe("createSpeechPlaybackController", () => {
  test("synthesizes then plays and returns to idle on ended", async () => {
    const audio = createMockAudio();
    const urls = createMockUrls();
    const snapshots: SpeechPlaybackSnapshot[] = [];
    const synthesize = mock(async () => new Uint8Array([1, 2, 3]));
    const cancel = mock(async () => true);

    const controller = createSpeechPlaybackController({
      audio,
      urls,
      synthesize,
      cancel,
      createRequestId: () => "req-1",
      onChange: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    await controller.speak({
      target: "source",
      text: "hello",
      languageId: "en",
    });

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(audio.playCalls).toBe(1);
    expect(audio.src).toBe("blob:mock-1");
    expect(controller.getSnapshot()).toEqual({
      status: "playing",
      target: "source",
      requestId: "req-1",
      error: null,
    });

    audio.endedHandler?.();
    expect(controller.getSnapshot().status).toBe("idle");
    expect(urls.revoked).toEqual(["blob:mock-1"]);
    expect(snapshots.some((s) => s.status === "synthesizing")).toBe(true);
  });

  test("replaces prior request and revokes prior URL", async () => {
    const audio = createMockAudio();
    const urls = createMockUrls();
    let resolveFirst!: (bytes: Uint8Array) => void;
    const first = new Promise<Uint8Array>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const synthesize = mock(async () => {
      call += 1;
      if (call === 1) {
        return first;
      }
      return new Uint8Array([9]);
    });
    const cancel = mock(async () => true);
    let requestCounter = 0;

    const controller = createSpeechPlaybackController({
      audio,
      urls,
      synthesize,
      cancel,
      createRequestId: () => {
        requestCounter += 1;
        return `req-${requestCounter}`;
      },
    });

    const firstSpeak = controller.speak({
      target: "source",
      text: "one",
      languageId: "en",
    });
    // Wait until the first request is mid-synthesis (stopInternal is async).
    for (let i = 0; i < 20 && controller.getSnapshot().status !== "synthesizing"; i += 1) {
      await Promise.resolve();
    }
    expect(controller.getSnapshot().status).toBe("synthesizing");
    expect(controller.getSnapshot().requestId).toBe("req-1");

    const secondSpeak = controller.speak({
      target: "output",
      text: "two",
      languageId: "zh",
    });
    for (let i = 0; i < 20 && controller.getSnapshot().requestId !== "req-2"; i += 1) {
      await Promise.resolve();
    }
    expect(cancel).toHaveBeenCalledWith("req-1");

    resolveFirst(new Uint8Array([1]));
    await firstSpeak;
    await secondSpeak;

    expect(controller.getSnapshot()).toEqual({
      status: "playing",
      target: "output",
      requestId: "req-2",
      error: null,
    });
    expect(urls.created).toEqual(["blob:mock-1"]);
    expect(audio.src).toBe("blob:mock-1");
  });

  test("stop cancels active request and revokes URL", async () => {
    const audio = createMockAudio();
    const urls = createMockUrls();
    const synthesize = mock(async () => new Uint8Array([1]));
    const cancel = mock(async () => true);

    const controller = createSpeechPlaybackController({
      audio,
      urls,
      synthesize,
      cancel,
      createRequestId: () => "req-stop",
    });

    await controller.speak({ target: "source", text: "hi", languageId: "en" });
    await controller.stop();

    expect(cancel).toHaveBeenCalledWith("req-stop");
    expect(urls.revoked).toEqual(["blob:mock-1"]);
    expect(controller.getSnapshot()).toEqual({
      status: "idle",
      target: null,
      requestId: null,
      error: null,
    });
  });

  test("play rejection surfaces playback_rejected without throwing from speak after setState", async () => {
    const audio = createMockAudio();
    audio.playImpl = async () => {
      throw new Error("NotAllowedError");
    };
    const urls = createMockUrls();
    const synthesize = mock(async () => new Uint8Array([1]));

    const controller = createSpeechPlaybackController({
      audio,
      urls,
      synthesize,
      cancel: async () => true,
      createRequestId: () => "req-play",
    });

    await controller.speak({ target: "output", text: "hi", languageId: "en" });
    expect(controller.getSnapshot()).toEqual({
      status: "idle",
      target: null,
      requestId: null,
      error: "playback_rejected",
    });
    expect(urls.revoked).toEqual(["blob:mock-1"]);
  });

  test("dispose cleans up without requiring stop", async () => {
    const audio = createMockAudio();
    const urls = createMockUrls();
    const cancel = mock(async () => true);
    const synthesize = mock(async () => new Uint8Array([4]));

    const controller = createSpeechPlaybackController({
      audio,
      urls,
      synthesize,
      cancel,
      createRequestId: () => "req-dispose",
    });

    await controller.speak({ target: "source", text: "bye", languageId: "en" });
    controller.dispose();
    expect(cancel).toHaveBeenCalledWith("req-dispose");
    expect(urls.revoked).toEqual(["blob:mock-1"]);
    expect(controller.getSnapshot().status).toBe("idle");
  });
});
