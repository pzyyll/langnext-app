// ABOUTME: Centralized frontend logger that writes through the Tauri log plugin.
// ABOUTME: Falls back to console outside Tauri; attachConsole only in Tauri DEV.

import {
  attachConsole,
  debug as pluginDebug,
  error as pluginError,
  info as pluginInfo,
  trace as pluginTrace,
  warn as pluginWarn,
} from "@tauri-apps/plugin-log";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const MAX_LENGTH = 2_000;
const REDACTED = "[REDACTED]";
const DETAIL_REDACTED = "[detail redacted]";

/** Sensitive identifier for key=value / "key": value scrubbing (defense-in-depth). */
const SENSITIVE_KEY =
  "(?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key|client[_-]?secret|password|passwd|secret|credentials?";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Scrub common secret-bearing substrings. Defense-in-depth only —
 * callers must still never pass secrets into the logger.
 */
function scrubSensitive(text: string): string {
  let out = text;
  // Header-style fields: clear the entire remaining value.
  out = out.replace(/\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*.*/gi, `$1: ${REDACTED}`);
  // Bearer tokens
  out = out.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);
  // key=value / key: value — quoted (may contain spaces), then unquoted
  out = out.replace(new RegExp(`\\b(${SENSITIVE_KEY})\\s*[:=]\\s*(?:"[^"]*"|'[^']*')`, "gi"), `$1=${REDACTED}`);
  out = out.replace(new RegExp(`\\b(${SENSITIVE_KEY})\\s*[:=]\\s*\\S+`, "gi"), `$1=${REDACTED}`);
  // JSON-ish "key": value
  out = out.replace(
    new RegExp(`("(?:${SENSITIVE_KEY})"\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,}\\]]+)`, "gi"),
    `$1${REDACTED}`,
  );
  return out;
}

function truncate(text: string): string {
  return text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH)}…`;
}

/**
 * Format optional detail without enumerating arbitrary objects, reading
 * constructor, or JSON.stringify. Property access is try-guarded so Proxy
 * traps cannot throw out of the logger.
 */
function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined) {
    return String(detail);
  }
  const kind = typeof detail;
  if (kind === "string") {
    return scrubSensitive(detail as string);
  }
  if (kind === "number" || kind === "boolean" || kind === "bigint" || kind === "symbol") {
    return String(detail);
  }
  if (kind === "function") {
    return "[function]";
  }
  if (kind !== "object") {
    return DETAIL_REDACTED;
  }

  // Only primitive message / code / name — never stack, never key enumeration.
  const parts: string[] = [];
  for (const key of ["message", "code", "name"] as const) {
    try {
      const value = (detail as Record<string, unknown>)[key];
      if (typeof value === "string") {
        parts.push(`${key}=${scrubSensitive(value)}`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}=${String(value)}`);
      }
    } catch {
      // getter / Proxy trap — ignore this field
    }
  }
  return parts.length > 0 ? parts.join(" ") : DETAIL_REDACTED;
}

function formatLogLine(message: string, detail?: unknown): string {
  const msg = scrubSensitive(message);
  if (detail === undefined) {
    return truncate(msg);
  }
  return truncate(`${msg} ${formatDetail(detail)}`);
}

const pluginWriters: Record<LogLevel, (message: string) => Promise<void>> = {
  trace: pluginTrace,
  debug: pluginDebug,
  info: pluginInfo,
  warn: pluginWarn,
  error: pluginError,
};

function write(level: LogLevel, message: string, detail?: unknown): void {
  let line: string;
  try {
    line = formatLogLine(message, detail);
  } catch {
    // Any Proxy/getter/scrubber failure must not escape the logger.
    line = "[log format failed]";
  }

  if (isTauriRuntime()) {
    void pluginWriters[level](line).catch(() => {
      console[level === "trace" ? "log" : level](line);
    });
    return;
  }
  console[level === "trace" ? "log" : level](line);
}

/** Application logger — prefer this over direct console or plugin imports. */
export const logger = {
  trace: (message: string, detail?: unknown) => {
    write("trace", message, detail);
  },
  debug: (message: string, detail?: unknown) => {
    write("debug", message, detail);
  },
  info: (message: string, detail?: unknown) => {
    write("info", message, detail);
  },
  warn: (message: string, detail?: unknown) => {
    write("warn", message, detail);
  },
  error: (message: string, detail?: unknown) => {
    write("error", message, detail);
  },
};

type DetachFn = () => void | Promise<void>;

let detachConsole: DetachFn | null = null;
let initPromise: Promise<void> | null = null;
/** Bumped on dispose so in-flight attachConsole results are unlisten'd, not stored. */
let attachEpoch = 0;

function safeUnlisten(unlisten: DetachFn | null): void {
  if (!unlisten) {
    return;
  }
  try {
    void Promise.resolve(unlisten()).catch(() => {
      // Detach errors are non-fatal; avoid logger to prevent recursion.
    });
  } catch {
    // Sync throw from unlisten — swallow.
  }
}

/**
 * Attach the webview console listener for Rust log events (once).
 * Only in Tauri + DEV: release builds omit the Webview log target.
 * Safe under Vite HMR via epoch + dispose.
 */
export async function initLogger(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  const epoch = attachEpoch;

  initPromise = (async () => {
    // Webview target is debug-only on the Rust side; skip attach in release.
    if (!isTauriRuntime() || !import.meta.env.DEV) {
      return;
    }
    try {
      const unlisten = await attachConsole();
      if (epoch !== attachEpoch) {
        safeUnlisten(unlisten);
        return;
      }
      detachConsole = unlisten;
    } catch {
      if (epoch === attachEpoch) {
        console.warn("logger_attach_console_failed");
      }
    }
  })();

  return initPromise;
}

/** Detach console forwarding and clear init state (HMR / tests). */
export function disposeLogger(): void {
  attachEpoch += 1;
  const unlisten = detachConsole;
  detachConsole = null;
  initPromise = null;
  safeUnlisten(unlisten);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLogger();
  });
}
