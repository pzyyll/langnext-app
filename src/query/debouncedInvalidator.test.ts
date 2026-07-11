// ABOUTME: Tests debounce coalesce and cancel for Query invalidation storms.
// ABOUTME: Uses real timers with short delays for deterministic batching.
import { describe, expect, test } from "bun:test";
import { createDebouncedInvalidator } from "./debouncedInvalidator";

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("createDebouncedInvalidator", () => {
	test("coalesces repeated schedules for the same key", async () => {
		const calls: string[] = [];
		const inv = createDebouncedInvalidator((key) => {
			calls.push(JSON.stringify(key));
		}, 30);

		inv.schedule(["models"]);
		inv.schedule(["models"]);
		inv.schedule(["models"]);
		await delay(50);

		expect(calls).toEqual([JSON.stringify(["models"])]);
	});

	test("keeps distinct keys independent", async () => {
		const calls: string[] = [];
		const inv = createDebouncedInvalidator((key) => {
			calls.push(JSON.stringify(key));
		}, 30);

		inv.schedule(["models"]);
		inv.schedule(["providers"]);
		await delay(50);

		expect(calls.sort()).toEqual([JSON.stringify(["models"]), JSON.stringify(["providers"])].sort());
	});

	test("cancel drops pending invalidations", async () => {
		const calls: string[] = [];
		const inv = createDebouncedInvalidator((key) => {
			calls.push(JSON.stringify(key));
		}, 30);

		inv.schedule(["models"]);
		inv.cancel();
		await delay(50);

		expect(calls).toEqual([]);
	});

	test("flush runs pending invalidations immediately", async () => {
		const calls: string[] = [];
		const inv = createDebouncedInvalidator((key) => {
			calls.push(JSON.stringify(key));
		}, 500);

		inv.schedule(["models"]);
		inv.flush();
		expect(calls).toEqual([JSON.stringify(["models"])]);
	});
});
