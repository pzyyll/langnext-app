// ABOUTME: Contract tests for profile selection apply generation guards.
// ABOUTME: Ensures slower fetches cannot clobber a newer selection.
import { describe, expect, test } from "bun:test";
import { shouldApplyProfileResult } from "./profileApplyGuard";

describe("shouldApplyProfileResult", () => {
	test("accepts only matching generation", () => {
		expect(shouldApplyProfileResult(1, 1)).toBe(true);
		expect(shouldApplyProfileResult(1, 2)).toBe(false);
		expect(shouldApplyProfileResult(3, 2)).toBe(false);
	});
});
