import { expect, test } from "nsh/test";
import { TTS_PLAYBACK_FILE_NAME, ttsPlaybackDirectory } from "./playback";

test("tts playback: a missing data directory does not throw", () => {
  expect(ttsPlaybackDirectory()).toBe(null);
});

test("tts playback: cleanup names are only generated mp3 clips", () => {
  expect(TTS_PLAYBACK_FILE_NAME.test("tts-11111111-1111-1111-1111-111111111111.mp3")).toBe(true);
  expect(TTS_PLAYBACK_FILE_NAME.test("TTS-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.MP3")).toBe(true);
  expect(TTS_PLAYBACK_FILE_NAME.test("notes.txt")).toBe(false);
  expect(TTS_PLAYBACK_FILE_NAME.test("clip.mp3")).toBe(false);
  expect(TTS_PLAYBACK_FILE_NAME.test("tts-not-a-uuid.mp3")).toBe(false);
});
