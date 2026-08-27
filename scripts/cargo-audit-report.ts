// ABOUTME: Format cargo-audit JSON into a concise vulnerability table.
// ABOUTME: Prints advisory ID, package, title, patched versions or UNPATCHED, and URL.
const UNPATCHED_LABEL = "UNPATCHED";
const TABLE_HEADERS = ["ID", "Package", "Title", "Patched", "URL"] as const;

export type CargoAuditVulnerability = {
  advisory?: {
    id?: unknown;
    title?: unknown;
    url?: unknown;
  };
  package?: {
    name?: unknown;
    version?: unknown;
  };
  versions?: {
    patched?: unknown;
  };
};

export type CargoAuditReport = {
  vulnerabilities?: {
    list?: unknown;
  };
};

export function parseAuditReport(raw: string): CargoAuditReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`malformed cargo-audit JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("malformed cargo-audit JSON: expected an object");
  }
  return parsed as CargoAuditReport;
}

export function listVulnerablePackageSpecs(report: CargoAuditReport): string[] {
  const seen = new Set<string>();
  const specs: string[] = [];
  for (const row of readVulnerabilityRows(report)) {
    const spec = `${row.packageName}@${row.packageVersion}`;
    if (seen.has(spec)) {
      continue;
    }
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}

export function formatAuditReport(report: CargoAuditReport): string {
  const rows = readVulnerabilityRows(report);
  const lines = [
    TABLE_HEADERS.join("\t"),
    ...rows.map((row) =>
      [row.id, `${row.packageName} ${row.packageVersion}`, row.title, row.patched, row.url].join("\t"),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function readVulnerabilityRows(report: CargoAuditReport): Array<{
  id: string;
  packageName: string;
  packageVersion: string;
  title: string;
  patched: string;
  url: string;
}> {
  const list = report.vulnerabilities?.list;
  if (!Array.isArray(list)) {
    throw new Error("malformed cargo-audit JSON: missing vulnerabilities.list");
  }

  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`malformed cargo-audit JSON: vulnerabilities.list[${index}] is not an object`);
    }
    const item = entry as CargoAuditVulnerability;
    const id = requiredString(item.advisory?.id, `vulnerabilities.list[${index}].advisory.id`);
    const title = requiredString(item.advisory?.title, `vulnerabilities.list[${index}].advisory.title`);
    const url = requiredString(item.advisory?.url, `vulnerabilities.list[${index}].advisory.url`);
    const packageName = requiredString(item.package?.name, `vulnerabilities.list[${index}].package.name`);
    const packageVersion = requiredString(item.package?.version, `vulnerabilities.list[${index}].package.version`);
    return {
      id,
      packageName,
      packageVersion,
      title,
      patched: formatPatched(item.versions?.patched),
      url,
    };
  });
}

function formatPatched(patched: unknown): string {
  if (!Array.isArray(patched) || patched.length === 0) {
    return UNPATCHED_LABEL;
  }
  const requirements = patched.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`malformed cargo-audit JSON: patched[${index}] is not a string`);
    }
    return value;
  });
  return requirements.join(", ");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`malformed cargo-audit JSON: missing ${field}`);
  }
  return value;
}

async function runCli(jsonPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await Bun.file(jsonPath).text();
  } catch (error) {
    console.error(`error: cannot read ${jsonPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  try {
    const report = parseAuditReport(raw);
    process.stdout.write(formatAuditReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  const jsonPath = Bun.argv[2];
  if (!jsonPath) {
    console.error("usage: bun scripts/cargo-audit-report.ts <cargo-audit.json>");
    process.exit(1);
  }
  await runCli(jsonPath);
}
