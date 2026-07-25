// ABOUTME: Framework-free one-audio speech playback state machine with injectable adapters.
// ABOUTME: Cancels prior synthesis, revokes Blob URLs, and exposes idle/synthesizing/playing states.
import { cancelSpeechSynthesis, synthesizeSpeech } from "../../storage/client";
import type { SpeechSynthesizeInput } from "../../storage/types";
import { newClientRequestId } from "../translate/newClientRequestId";

export type SpeechPlaybackStatus = "idle" | "synthesizing" | "playing";
export type SpeechPlaybackTarget = "source" | "output";

export type SpeechAudioAdapter = {
  pause: () => void;
  play: () => Promise<void>;
  setSrc: (url: string) => void;
  clearSrc: () => void;
  setOnEnded: (handler: (() => void) | null) => void;
  setOnError: (handler: (() => void) | null) => void;
};

export type SpeechUrlAdapter = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};

export type SpeechSynthesizeFn = (input: SpeechSynthesizeInput) => Promise<Uint8Array>;
export type SpeechCancelFn = (requestId: string) => Promise<boolean>;

export type SpeechPlaybackSnapshot = {
  status: SpeechPlaybackStatus;
  target: SpeechPlaybackTarget | null;
  requestId: string | null;
  error: string | null;
};

export type SpeechPlaybackControllerOptions = {
  audio: SpeechAudioAdapter;
  urls: SpeechUrlAdapter;
  synthesize?: SpeechSynthesizeFn;
  cancel?: SpeechCancelFn;
  createRequestId?: () => string;
  onChange?: (snapshot: SpeechPlaybackSnapshot) => void;
};

/** Create a default HTMLAudioElement adapter when running in a browser. */
export function createBrowserAudioAdapter(audio: HTMLAudioElement = new Audio()): SpeechAudioAdapter {
  return {
    pause: () => {
      audio.pause();
    },
    play: () => audio.play(),
    setSrc: (url) => {
      audio.src = url;
    },
    clearSrc: () => {
      audio.removeAttribute("src");
      audio.load();
    },
    setOnEnded: (handler) => {
      audio.onended = handler;
    },
    setOnError: (handler) => {
      audio.onerror = handler;
    },
  };
}

/** Create a default URL.createObjectURL / revokeObjectURL adapter. */
export function createBrowserUrlAdapter(): SpeechUrlAdapter {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
  };
}

export function createSpeechPlaybackController(options: SpeechPlaybackControllerOptions) {
  const synthesize = options.synthesize ?? synthesizeSpeech;
  const cancel = options.cancel ?? cancelSpeechSynthesis;
  const createRequestId = options.createRequestId ?? (() => newClientRequestId("speech"));
  const audioMimeType = "audio/mpeg";

  let status: SpeechPlaybackStatus = "idle";
  let target: SpeechPlaybackTarget | null = null;
  let requestId: string | null = null;
  let error: string | null = null;
  let objectUrl: string | null = null;
  let generation = 0;

  function snapshot(): SpeechPlaybackSnapshot {
    return { status, target, requestId, error };
  }

  function emit() {
    options.onChange?.(snapshot());
  }

  function setState(next: Partial<SpeechPlaybackSnapshot>) {
    if (next.status !== undefined) status = next.status;
    if (next.target !== undefined) target = next.target;
    if (next.requestId !== undefined) requestId = next.requestId;
    if (next.error !== undefined) error = next.error;
    emit();
  }

  function revokeObjectUrl() {
    if (!objectUrl) {
      return;
    }
    options.urls.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function resetAudio() {
    options.audio.pause();
    options.audio.setOnEnded(null);
    options.audio.setOnError(null);
    options.audio.clearSrc();
    revokeObjectUrl();
  }

  async function cancelActiveRequest() {
    const activeRequestId = requestId;
    if (!activeRequestId) {
      return;
    }
    try {
      await cancel(activeRequestId);
    } catch {
      // Cancellation is best-effort; replacement/stop must continue.
    }
  }

  async function stopInternal(options_?: { emitIdle?: boolean }) {
    generation += 1;
    await cancelActiveRequest();
    resetAudio();
    if (options_?.emitIdle === false) {
      return;
    }
    setState({ status: "idle", target: null, requestId: null, error: null });
  }

  async function speak(input: {
    target: SpeechPlaybackTarget;
    text: string;
    languageId: string;
    speechServiceId?: string | null;
  }): Promise<SpeechPlaybackSnapshot> {
    const trimmed = input.text.trim();
    if (!trimmed) {
      return snapshot();
    }

    await stopInternal({ emitIdle: false });
    const myGeneration = generation;
    const nextRequestId = createRequestId();
    setState({
      status: "synthesizing",
      target: input.target,
      requestId: nextRequestId,
      error: null,
    });

    try {
      const bytes = await synthesize({
        text: trimmed,
        languageId: input.languageId,
        speechServiceId: input.speechServiceId ?? null,
        requestId: nextRequestId,
      });
      if (myGeneration !== generation) {
        return snapshot();
      }

      // Copy into a standalone ArrayBuffer so BlobPart typing accepts the MP3 bytes.
      const audioBytes = new Uint8Array(bytes.byteLength);
      audioBytes.set(bytes);
      const blob = new Blob([audioBytes.buffer], { type: audioMimeType });
      const url = options.urls.createObjectURL(blob);
      objectUrl = url;
      options.audio.setSrc(url);
      options.audio.setOnEnded(() => {
        if (myGeneration !== generation) {
          return;
        }
        resetAudio();
        setState({ status: "idle", target: null, requestId: null, error: null });
      });
      options.audio.setOnError(() => {
        if (myGeneration !== generation) {
          return;
        }
        resetAudio();
        setState({
          status: "idle",
          target: null,
          requestId: null,
          error: "playback_failed",
        });
      });

      setState({ status: "playing", target: input.target, requestId: nextRequestId, error: null });
      try {
        await options.audio.play();
      } catch {
        if (myGeneration !== generation) {
          return snapshot();
        }
        resetAudio();
        setState({
          status: "idle",
          target: null,
          requestId: null,
          error: "playback_rejected",
        });
      }
      return snapshot();
    } catch (err) {
      if (myGeneration !== generation) {
        return snapshot();
      }
      resetAudio();
      const code =
        err !== null && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
          ? (err as { code: string }).code
          : "synthesize_failed";
      setState({
        status: "idle",
        target: null,
        requestId: null,
        error: code,
      });
      throw err;
    }
  }

  async function stop(): Promise<void> {
    await stopInternal();
  }

  function getSnapshot(): SpeechPlaybackSnapshot {
    return snapshot();
  }

  function dispose(): void {
    generation += 1;
    void cancelActiveRequest();
    resetAudio();
    status = "idle";
    target = null;
    requestId = null;
    error = null;
  }

  return {
    speak,
    stop,
    getSnapshot,
    dispose,
  };
}

export type SpeechPlaybackController = ReturnType<typeof createSpeechPlaybackController>;
