// The app's logger: `console` lines, which NSH writes to the `log` facade with target `js`.

/**
 * One source's log lines. Each line starts with `[scope]`, so the app log says where it
 * came from. Details are logged as they are: never pass a secret, a credential, or a
 * request body.
 */
export interface Logger {
  /** Kept only with `RUST_LOG`; use it while diagnosing one path. */
  debug(message: string, ...details: unknown[]): void;
  /** Kept in every build: a step worth reading in a report. */
  info(message: string, ...details: unknown[]): void;
  /** A failure the app recovered from, so the log explains the degraded state. */
  warn(message: string, ...details: unknown[]): void;
  /** A failure the app could not handle. */
  error(message: string, ...details: unknown[]): void;
}

/**
 * Creates a logger that writes every line as `[scope] message` through `console`.
 *
 * NSH writes `console` calls to the `log` facade as the target `js`: `warn` and
 * `error` always reach the app's log file, `info` reaches it in every build, and
 * `debug` needs `RUST_LOG=debug`. The runtime records uncaught errors and panics
 * itself, so this module covers handled failures only.
 */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    debug: (message, ...details) => console.debug(`${prefix} ${message}`, ...details),
    info: (message, ...details) => console.info(`${prefix} ${message}`, ...details),
    warn: (message, ...details) => console.warn(`${prefix} ${message}`, ...details),
    error: (message, ...details) => console.error(`${prefix} ${message}`, ...details),
  };
}

/** The file NSH writes the app's log lines to; `null` when they go to the platform's log only. */
export function logFile(): string | null {
  return process.logFile;
}
