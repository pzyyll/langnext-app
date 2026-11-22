import { AudioPlayer } from "nsh";
import { mkdir, readdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";

/** App-owned directory under the data directory. Playback files live only here. */
export const TTS_PLAYBACK_DIRECTORY = "tts-playback";

/** Generated clip names. Startup cleanup deletes these and nothing else. */
export const TTS_PLAYBACK_FILE_NAME =
  /^tts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/i;

export type Mp3Playback =
  | { status: "ended" }
  | { status: "stopped" }
  | { status: "failed"; failure: "unavailable" | "playback" };

export interface Mp3PlaybackHandle {
  stop(): void;
  result: Promise<Mp3Playback>;
}

export function ttsPlaybackDirectory(): string | null {
  const root = appDataDirectory();
  if (root === null) return null;
  return join(root, TTS_PLAYBACK_DIRECTORY);
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;
    encoded += alphabet[(chunk >> 18) & 63];
    encoded += alphabet[(chunk >> 12) & 63];
    encoded += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
    encoded += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
  }
  return encoded;
}

function headlessPlaybackUrl(name: string, bytes: Uint8Array): string {
  return `data:audio/mpeg;filename=${TTS_PLAYBACK_DIRECTORY}/${name};base64,${encodeBase64(bytes)}`;
}

function appDataDirectory(): string | null {
  // The bundled default import of `process` does not carry the live dataDir getter.
  const runtime = (globalThis as { process?: { dataDir?: string | null } }).process;
  const root = runtime?.dataDir;
  if (typeof root !== "string" || root.length === 0) return null;
  return root;
}

/** Whether this device can open a local player. A missing data directory is not a refusal: the headless test engine keeps no files. */
export async function canPlayTts(): Promise<boolean> {
  try {
    return await AudioPlayer.available();
  } catch {
    return false;
  }
}

/** Deletes generated clips in `directory`. Other names stay. A missing directory is ignored. */
export async function removeGeneratedPlaybackFiles(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => TTS_PLAYBACK_FILE_NAME.test(name))
      .map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

/** Deletes generated clips left by an earlier run. Other files in the directory stay. */
export async function cleanupTtsPlaybackFiles(): Promise<void> {
  const directory = ttsPlaybackDirectory();
  if (directory === null) return;
  await removeGeneratedPlaybackFiles(directory);
}

/**
 * Writes MP3 bytes to a temporary file and plays that file.
 * `stop` disposes the player before the file is removed. A write that finishes
 * after stop still removes the file and does not play it.
 */
export function playMp3Bytes(
  bytes: Uint8Array,
  hooks?: { onPlaying?: () => void },
): Mp3PlaybackHandle {
  let stopRequested = false;
  let written = false;
  let player: AudioPlayer | null = null;
  let filePath: string | null = null;
  let settled = false;
  let resolveResult: (value: Mp3Playback) => void = () => {};
  const result = new Promise<Mp3Playback>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (value: Mp3Playback) => {
    if (settled) return;
    settled = true;
    const current = player;
    player = null;
    if (current) {
      try {
        current.dispose();
      } catch {
        // The player may already be disposed by stop or by its own end.
      }
    }
    const path = filePath;
    filePath = null;
    void (async () => {
      if (path !== null && written) await unlink(path).catch(() => undefined);
      resolveResult(value);
    })();
  };

  const stop = () => {
    stopRequested = true;
    // A stop during the write waits until the write returns, then deletes the file.
    if (player !== null) finish({ status: "stopped" });
  };

  void (async () => {
    try {
      if (!(await canPlayTts())) {
        finish({ status: "failed", failure: "unavailable" });
        return;
      }
      if (stopRequested) {
        finish({ status: "stopped" });
        return;
      }
      const name = `tts-${crypto.randomUUID()}.mp3`;
      const directory = ttsPlaybackDirectory();
      // Headless tests have no data directory. A file URL is refused there, so
      // the player receives the bytes in a data URL. A desktop host writes a file.
      let src = headlessPlaybackUrl(name, bytes);
      if (directory !== null) {
        const path = join(directory, name);
        filePath = path;
        await mkdir(directory, { recursive: true });
        if (stopRequested) {
          finish({ status: "stopped" });
          return;
        }
        written = true;
        await writeFile(path, bytes);
        if (stopRequested) {
          finish({ status: "stopped" });
          return;
        }
        src = pathToFileURL(path).href;
      }
      const next = new AudioPlayer(src);
      player = next;
      next.on("end", () => finish({ status: "ended" }));
      next.on("error", () => finish({ status: "failed", failure: "playback" }));
      if (stopRequested) {
        finish({ status: "stopped" });
        return;
      }
      await next.play();
      if (settled) return;
      if (stopRequested) {
        finish({ status: "stopped" });
        return;
      }
      hooks?.onPlaying?.();
    } catch {
      finish(stopRequested ? { status: "stopped" } : { status: "failed", failure: "playback" });
    }
  })();

  return { stop, result };
}
