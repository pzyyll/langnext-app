// ABOUTME: Fixtures for Vite/Rolldown build-log diagnostic classification.
// ABOUTME: Covers oversized chunks, unresolved warnings, and non-warning summaries.
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { findBuildDiagnostics } from "./frontend-bundle-diagnostics";

const VITE_OVERSIZED_CHUNK_BLOCK = `(!) Some chunks are larger than 500 kB after minification.
Consider:
- Using dynamic import() to code-split the application
- Use build.rolldownOptions.output.manualChunks to improve chunking
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.`;

const ROLLDOWN_WARNING_BLOCK = `WARN Invalid option "build.rollupOptions". Did you mean "build.rolldownOptions"?
  help: Vite 8 uses Rolldown. Update the config key.`;

const BRACKET_WARNING_BLOCK = `[WARNING] Duplicate export name`;

const UNRESOLVED_WARNING_BLOCK = `UNRESOLVED_WARNING: circular dependency in chunk graph`;

const UNRESOLVED_IMPORT_BLOCK = `UNRESOLVED_IMPORT: cannot resolve "./missing-module"`;

const NORMAL_VITE_SUMMARY = `vite v8.1.4 building client environment for production...
transforming...
✓ 1234 modules transformed.
rendering chunks...
computing gzip size...
dist/assets/index-a1b2c3d4.js   148.22 kB │ gzip: 48.10 kB
✓ built in 3.21s`;

const APPLICATION_WARNING_PROSE = `info saved preference
The warning preference is saved
built application bundle`;

describe("findBuildDiagnostics", () => {
  test("returns the complete Vite oversized-chunk warning block", () => {
    const output = `${NORMAL_VITE_SUMMARY}\n${VITE_OVERSIZED_CHUNK_BLOCK}\n\n${NORMAL_VITE_SUMMARY}`;
    expect(findBuildDiagnostics(output)).toEqual([VITE_OVERSIZED_CHUNK_BLOCK]);
  });

  test("returns Rolldown and unresolved diagnostic blocks", () => {
    const output = [
      ROLLDOWN_WARNING_BLOCK,
      "",
      BRACKET_WARNING_BLOCK,
      "",
      UNRESOLVED_WARNING_BLOCK,
      "  continued unresolved detail",
      "",
      UNRESOLVED_IMPORT_BLOCK,
    ].join("\n");

    expect(findBuildDiagnostics(output)).toEqual([
      ROLLDOWN_WARNING_BLOCK,
      BRACKET_WARNING_BLOCK,
      `${UNRESOLVED_WARNING_BLOCK}\n  continued unresolved detail`,
      UNRESOLVED_IMPORT_BLOCK,
    ]);
  });

  test("ignores normal Vite summaries and application text containing warning", () => {
    expect(findBuildDiagnostics(NORMAL_VITE_SUMMARY)).toEqual([]);
    expect(findBuildDiagnostics(APPLICATION_WARNING_PROSE)).toEqual([]);
  });

  test("CLI prints the oversized block and exits 1", async () => {
    const logPath = `${tmpdir()}/frontend-bundle-diagnostics-warning-${crypto.randomUUID()}.log`;
    await Bun.write(logPath, `${VITE_OVERSIZED_CHUNK_BLOCK}\n`);
    const child = Bun.spawn({
      cmd: ["bun", "scripts/frontend-bundle-diagnostics.ts", logPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    expect(exitCode).toBe(1);
    expect(stderr.trim()).toBe(VITE_OVERSIZED_CHUNK_BLOCK);
  });

  test("CLI exits 0 for a clean Vite summary", async () => {
    const logPath = `${tmpdir()}/frontend-bundle-diagnostics-clean-${crypto.randomUUID()}.log`;
    await Bun.write(logPath, `${NORMAL_VITE_SUMMARY}\n`);
    const child = Bun.spawn({
      cmd: ["bun", "scripts/frontend-bundle-diagnostics.ts", logPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
