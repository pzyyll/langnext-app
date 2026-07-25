// ABOUTME: React lifecycle wrapper around the injectable Speech playback controller.
// ABOUTME: Creates browser audio/URL adapters on mount and disposes them on unmount.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBrowserAudioAdapter,
  createBrowserUrlAdapter,
  createSpeechPlaybackController,
  type SpeechPlaybackSnapshot,
  type SpeechPlaybackTarget,
} from "./speechPlaybackController";

const IDLE_SNAPSHOT: SpeechPlaybackSnapshot = {
  status: "idle",
  target: null,
  requestId: null,
  error: null,
};

export type UseSpeechPlaybackResult = {
  status: SpeechPlaybackSnapshot["status"];
  target: SpeechPlaybackTarget | null;
  error: string | null;
  isActive: boolean;
  isTargetActive: (target: SpeechPlaybackTarget) => boolean;
  speak: (input: {
    target: SpeechPlaybackTarget;
    text: string;
    languageId: string;
    speechServiceId?: string | null;
  }) => Promise<SpeechPlaybackSnapshot>;
  stop: () => Promise<void>;
};

/** Mount a single shared Speech playback controller for source/result controls. */
export function useSpeechPlayback(): UseSpeechPlaybackResult {
  const [snapshot, setSnapshot] = useState<SpeechPlaybackSnapshot>(IDLE_SNAPSHOT);
  const controllerRef = useRef<ReturnType<typeof createSpeechPlaybackController> | null>(null);

  useEffect(() => {
    const controller = createSpeechPlaybackController({
      audio: createBrowserAudioAdapter(),
      urls: createBrowserUrlAdapter(),
      onChange: setSnapshot,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  return useMemo(
    () => ({
      status: snapshot.status,
      target: snapshot.target,
      error: snapshot.error,
      isActive: snapshot.status !== "idle",
      isTargetActive: (target: SpeechPlaybackTarget) => snapshot.target === target && snapshot.status !== "idle",
      speak: async (input) => {
        const controller = controllerRef.current;
        if (!controller) {
          return IDLE_SNAPSHOT;
        }
        return controller.speak(input);
      },
      stop: async () => {
        const controller = controllerRef.current;
        if (!controller) {
          return;
        }
        await controller.stop();
      },
    }),
    [snapshot],
  );
}
