// ABOUTME: Contract tests for Query key hierarchy and prefix invalidation shape.
// ABOUTME: Pure key factories only — no DOM or IPC required.
import { describe, expect, test } from "bun:test";
import { modelKeys, profileKeys, providerKeys } from "./keys";

describe("providerKeys", () => {
	test("list key starts with providerKeys.all", () => {
		const list = providerKeys.list();
		expect(list[0]).toBe(providerKeys.all[0]);
		expect(list).toEqual(["providers", "list"]);
	});
});

describe("modelKeys", () => {
	test("allEnabled and byProvider share modelKeys.all prefix", () => {
		const allEnabled = modelKeys.allEnabled();
		const byProvider = modelKeys.byProvider("prov-1");
		expect(allEnabled[0]).toBe(modelKeys.all[0]);
		expect(byProvider[0]).toBe(modelKeys.all[0]);
		expect(allEnabled).toEqual(["models", "enabled"]);
		expect(byProvider).toEqual(["models", "provider", "prov-1"]);
	});

	test("provider-scoped keys differ by provider id and from allEnabled", () => {
		const a = modelKeys.byProvider("a");
		const b = modelKeys.byProvider("b");
		expect(a).not.toEqual(b);
		expect(a).not.toEqual(modelKeys.allEnabled());
	});
});

describe("profileKeys", () => {
	test("every detail key starts with profileKeys.all and differs by id", () => {
		const list = profileKeys.list();
		const detailA = profileKeys.detail("id-a");
		const detailB = profileKeys.detail("id-b");

		expect(list[0]).toBe(profileKeys.all[0]);
		expect(detailA[0]).toBe(profileKeys.all[0]);
		expect(detailB[0]).toBe(profileKeys.all[0]);

		expect(detailA).toEqual(["translation-profiles", "detail", "id-a"]);
		expect(detailB).toEqual(["translation-profiles", "detail", "id-b"]);
		expect(detailA).not.toEqual(detailB);
		expect(list).toEqual(["translation-profiles", "list"]);
	});
});
