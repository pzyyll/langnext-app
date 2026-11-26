// ABOUTME: The app data directory the host gives this process.
// ABOUTME: Headless tests and the web have none, so callers must tolerate null.

/** The app data directory, or null when this host keeps no files. */
export function appDataDirectory(): string | null {
  // The bundled default import of `process` does not carry the live dataDir getter.
  const runtime = (globalThis as { process?: { dataDir?: string | null } }).process;
  const root = runtime?.dataDir;
  if (typeof root !== "string" || root.length === 0) return null;
  return root;
}
