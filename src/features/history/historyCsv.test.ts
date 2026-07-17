// ABOUTME: Unit tests for the history CSV builder (escaping, headers, BOM).
// ABOUTME: Run with `bun test src/features/history/historyCsv.test.ts`.
import { describe, expect, it } from "bun:test";
import { buildHistoryCsv, escapeCsvField } from "./historyCsv";
import type { TranslationHistoryDto } from "../../storage/types";

function sampleRow(overrides: Partial<TranslationHistoryDto> = {}): TranslationHistoryDto {
	return {
		id: "id-1",
		createdAt: "2026-07-17T10:30:00Z",
		sourceText: "hello",
		translatedText: "你好",
		sourceLang: "English",
		targetLang: "Chinese",
		effectiveSourceLang: "en",
		effectiveTargetLang: "zh",
		modelId: "model-1",
		modelDisplayName: "GPT",
		providerDisplayName: "OpenAI",
		profileId: null,
		profileName: null,
		status: "complete",
		errorCode: null,
		errorMessage: null,
		latencyMs: 42,
		...overrides,
	};
}

describe("escapeCsvField", () => {
	it("leaves plain text unchanged", () => {
		expect(escapeCsvField("hello")).toBe("hello");
	});

	it("wraps fields containing a comma", () => {
		expect(escapeCsvField("a,b")).toBe('"a,b"');
	});

	it("doubles inner double quotes", () => {
		expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
	});

	it("wraps fields containing newlines", () => {
		expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
	});

	it("treats null and undefined as empty", () => {
		expect(escapeCsvField(null)).toBe("");
		expect(escapeCsvField(undefined)).toBe("");
	});
});

describe("buildHistoryCsv", () => {
	it("starts with a UTF-8 BOM and header row", () => {
		const csv = buildHistoryCsv([]);
		expect(csv.startsWith("\uFEFF")).toBe(true);
		const lines = csv.slice(1).split("\r\n");
		expect(lines[0]).toBe(
			"Created At,Source Language,Target Language,Effective Source,Effective Target,Model,Provider,Profile,Status,Latency (ms),Error Code,Error Message,Source Text,Translated Text",
		);
	});

	it("emits one row per history entry with escaped fields", () => {
		const csv = buildHistoryCsv([
			sampleRow({
				sourceText: 'hello, "world"',
				translatedText: "line1\nline2",
				profileName: "Default, Tech",
			}),
		]);
		const lines = csv.slice(1).split("\r\n");
		// header + data row + trailing empty (final newline)
		expect(lines).toHaveLength(3);
		const fields = parseCsvLine(lines[1]);
		expect(fields[12]).toBe('hello, "world"');
		expect(fields[13]).toBe("line1\nline2");
		expect(fields[7]).toBe("Default, Tech");
		expect(fields[8]).toBe("complete");
		expect(fields[9]).toBe("42");
	});

	it("handles failed rows with error fields", () => {
		const csv = buildHistoryCsv([
			sampleRow({
				status: "failed",
				translatedText: "",
				errorCode: "network",
				errorMessage: "boom",
			}),
		]);
		const lines = csv.slice(1).split("\r\n");
		const fields = parseCsvLine(lines[1]);
		expect(fields[8]).toBe("failed");
		expect(fields[10]).toBe("network");
		expect(fields[11]).toBe("boom");
	});
});

/** Minimal RFC 4180 line parser for test assertions only. */
function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === '"') {
			let value = "";
			i += 1;
			while (i < line.length) {
				if (line[i] === '"') {
					if (line[i + 1] === '"') {
						value += '"';
						i += 2;
					} else {
						i += 1;
						break;
					}
				} else {
					value += line[i];
					i += 1;
				}
			}
			fields.push(value);
			if (line[i] === ",") {
				i += 1;
			}
		} else {
			let value = "";
			while (i < line.length && line[i] !== ",") {
				value += line[i];
				i += 1;
			}
			fields.push(value);
			if (line[i] === ",") {
				i += 1;
			}
		}
	}
	return fields;
}
