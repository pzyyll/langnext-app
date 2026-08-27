// ABOUTME: Parse Vite/Rolldown production-build logs for warning diagnostic blocks.
// ABOUTME: Prints captured blocks to stderr and exits nonzero when any diagnostic exists.
const DIAGNOSTIC_START_PATTERNS: readonly RegExp[] = [
  /^\s*\(!\)\s+\S/,
  /^\s*\[WARNING\]/,
  /^\s*UNRESOLVED_WARNING\b/,
  /^\s*UNRESOLVED_IMPORT\b/,
  /^\s*(?:warn|warning)\b/i,
  /^\s*(?:vite|rolldown|rollup)(?:\s*[-:]\s*|\s+)\S/i,
];

const PROGRESS_LINE_PATTERN = /^\s*(?:✓|built\b|rendering\b|transforming\b|computing gzip\b|info\b|dist\/)/i;
const CONTINUATION_LINE_PATTERN = /^(?:\s+|[*-]\s+)/;
const TOOL_WARNING_LINE_PATTERN = /^\s*(?:vite|rolldown|rollup)\b.*\b(?:warn|warning)\b/i;

export function findBuildDiagnostics(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const diagnostics: string[] = [];
  let current: string[] | undefined;

  const flush = () => {
    if (current && current.length > 0) {
      diagnostics.push(current.join("\n"));
    }
    current = undefined;
  };

  for (const line of lines) {
    if (isDiagnosticStart(line)) {
      flush();
      current = [line];
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.length === 0 || isProgressLine(line)) {
      flush();
      continue;
    }
    if (CONTINUATION_LINE_PATTERN.test(line) || !isDiagnosticStart(line)) {
      current.push(line);
    }
  }
  flush();
  return diagnostics;
}

function isDiagnosticStart(line: string): boolean {
  if (DIAGNOSTIC_START_PATTERNS.some((pattern) => pattern.test(line))) {
    if (TOOL_WARNING_LINE_PATTERN.test(line)) {
      return true;
    }
    if (/^\s*(?:vite|rolldown|rollup)(?:\s*[-:]\s*|\s+)\S/i.test(line)) {
      return /\b(?:warn|warning)\b/i.test(line);
    }
    return true;
  }
  return false;
}

function isProgressLine(line: string): boolean {
  return PROGRESS_LINE_PATTERN.test(line);
}

async function runCli(logPath: string): Promise<void> {
  const output = await Bun.file(logPath).text();
  const diagnostics = findBuildDiagnostics(output);
  for (const block of diagnostics) {
    console.error(block);
  }
  process.exit(diagnostics.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  const logPath = Bun.argv[2];
  if (!logPath) {
    console.error("usage: bun scripts/frontend-bundle-diagnostics.ts <build-log>");
    process.exit(1);
  }
  await runCli(logPath);
}
