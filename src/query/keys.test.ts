// ABOUTME: Contract tests for Query key hierarchy and prefix invalidation shape.
// ABOUTME: Pure key factories only — no DOM or IPC required.
import { describe, expect, test } from "bun:test";
import { integrationKeys, modelKeys, ocrKeys, profileKeys, providerKeys } from "./keys";

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

describe("ocrKeys", () => {
  test("list and detail keys share ocrKeys.all prefix", () => {
    const list = ocrKeys.list();
    const detailA = ocrKeys.detail("id-a");
    const detailB = ocrKeys.detail("id-b");

    expect(list[0]).toBe(ocrKeys.all[0]);
    expect(detailA[0]).toBe(ocrKeys.all[0]);
    expect(detailB[0]).toBe(ocrKeys.all[0]);

    expect(list).toEqual(["ocr-services", "list"]);
    expect(detailA).toEqual(["ocr-services", "detail", "id-a"]);
    expect(detailB).toEqual(["ocr-services", "detail", "id-b"]);
    expect(detailA).not.toEqual(detailB);
  });
});

describe("integrationKeys", () => {
  test("list, detail, definitions, and dependencies share integrationKeys.all prefix", () => {
    const list = integrationKeys.list();
    const detailA = integrationKeys.detail("id-a");
    const detailB = integrationKeys.detail("id-b");
    const definitions = integrationKeys.definitions();
    const dependencies = integrationKeys.dependencies("id-a");

    expect(list[0]).toBe(integrationKeys.all[0]);
    expect(detailA[0]).toBe(integrationKeys.all[0]);
    expect(detailB[0]).toBe(integrationKeys.all[0]);
    expect(definitions[0]).toBe(integrationKeys.all[0]);
    expect(dependencies[0]).toBe(integrationKeys.all[0]);

    expect(list).toEqual(["service-integrations", "list"]);
    expect(detailA).toEqual(["service-integrations", "detail", "id-a"]);
    expect(detailB).toEqual(["service-integrations", "detail", "id-b"]);
    expect(definitions).toEqual(["service-integrations", "definitions"]);
    expect(dependencies).toEqual(["service-integrations", "dependencies", "id-a"]);
    expect(detailA).not.toEqual(detailB);
  });
});
