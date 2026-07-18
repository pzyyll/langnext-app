// ABOUTME: Pure CSV builder for translation history export (RFC 4180 + UTF-8 BOM).
// ABOUTME: No Tauri/React dependencies so it stays unit-testable.
import type { TranslationHistoryDto } from "../../storage/types";

const BOM = "\uFEFF";
const NEWLINE = "\r\n";

const HEADERS = [
  "Created At",
  "Source Language",
  "Target Language",
  "Effective Source",
  "Effective Target",
  "Model",
  "Provider",
  "Profile",
  "Status",
  "Latency (ms)",
  "Error Code",
  "Error Message",
  "Source Text",
  "Translated Text",
] as const;

/** Quote a single CSV field per RFC 4180: wrap in quotes and double inner quotes. */
export function escapeCsvField(value: string | null | undefined): string {
  const text = value ?? "";
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Build a UTF-8 BOM CSV document from full history rows. */
export function buildHistoryCsv(rows: readonly TranslationHistoryDto[]): string {
  const lines: string[] = [HEADERS.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.createdAt,
        row.sourceLang,
        row.targetLang,
        row.effectiveSourceLang,
        row.effectiveTargetLang,
        row.modelDisplayName,
        row.providerDisplayName,
        row.profileName,
        row.status,
        String(row.latencyMs),
        row.errorCode,
        row.errorMessage,
        row.sourceText,
        row.translatedText,
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  return BOM + lines.join(NEWLINE) + NEWLINE;
}
