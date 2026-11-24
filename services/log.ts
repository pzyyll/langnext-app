// The app's logger: `console` lines, which NSH writes to the `log` facade with target `js`.

import { signal } from "nsh";

/**
 * The lowest level the app's log calls write. `debug` is not one: it follows
 * `RUST_LOG`, so that a developer keeps it without the app changing it.
 */
export type LogLevel = "error" | "warn" | "info";

/** How loud each level is: a level writes itself and every louder one. */
const SEVERITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2 };

const level = signal<LogLevel>("warn");

/** The lowest level the app's log calls write now. */
export function logLevel(): LogLevel {
  return level();
}

/** Sets the lowest level the app's log calls keep from here on. */
export function setLogLevel(value: LogLevel) {
  level.set(value);
}

/** True when a call at `record` is loud enough for the current level. */
function writes(record: LogLevel): boolean {
  return SEVERITY[record] <= SEVERITY[level()];
}

/**
 * One source's log lines. Each line starts with `[scope]`, so the app log says where it
 * came from. Details are logged as they are: never pass a secret, a credential, or a
 * request body.
 */
export interface Logger {
  /** Kept only with `RUST_LOG`; use it while diagnosing one path. */
  debug(message: string, ...details: unknown[]): void;
  /** Kept from the `info` level up: a step worth reading in a report. */
  info(message: string, ...details: unknown[]): void;
  /** Kept from the `warn` level up: a failure the app recovered from, so the log explains the degraded state. */
  warn(message: string, ...details: unknown[]): void;
  /** Kept at every level: a failure the app could not handle. */
  error(message: string, ...details: unknown[]): void;
}

/**
 * Creates a logger that writes every kept line as `[scope] message` through `console`.
 *
 * NSH writes `console` calls to the `log` facade as the target `js`. The level set
 * through `setLogLevel` decides which of them this module writes, and NSH keeps
 * what it writes as it keeps any `js` line. `debug` stays outside that level and
 * needs `RUST_LOG=debug`. The runtime records uncaught errors and panics itself,
 * so this module covers handled failures only.
 */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    debug: (message, ...details) => console.debug(`${prefix} ${message}`, ...details),
    info: (message, ...details) => {
      if (writes("info")) console.info(`${prefix} ${message}`, ...details);
    },
    warn: (message, ...details) => {
      if (writes("warn")) console.warn(`${prefix} ${message}`, ...details);
    },
    error: (message, ...details) => {
      if (writes("error")) console.error(`${prefix} ${message}`, ...details);
    },
  };
}

/** The file NSH writes the app's log lines to; `null` when they go to the platform's log only. */
export function logFile(): string | null {
  return process.logFile;
}
