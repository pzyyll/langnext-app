// ABOUTME: Pure presentation tests for the import preview dialog (counts/actions/warnings).
// ABOUTME: No React, IPC, or i18n runtime; helpers return stable keys and grouped data.
import { describe, expect, test } from "bun:test";
import type {
  ImportPreview,
  ImportRuntimeLocalStatus,
  ImportRuntimeRequiredAction,
  ImportRuntimeRequirementPreview,
} from "../../storage/types";
import {
  IMPORT_INACTIVE_RUNTIME_COPY_KEY,
  groupImportRuntimeRequirements,
  importAuthenticationCategories,
  importAuthenticationCategoryLabelKey,
  importGraphCountSummaries,
  importHasPackageBackedRuntimes,
  importModeLabelKey,
  importRuntimeActionLabelKey,
  importRuntimeDetailRows,
  importRuntimeStatusLabelKey,
} from "./importPreviewPresentation";

function preview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  return {
    valid: true,
    counts: {
      providersCreate: 1,
      providersUpdate: 2,
      providersCopy: 0,
      modelsCreate: 3,
      modelsUpdate: 0,
      modelsCopy: 0,
      profilesCreate: 0,
      profilesUpdate: 0,
      profilesCopy: 4,
      integrationsCreate: 0,
      integrationsUpdate: 1,
      integrationsCopy: 0,
      ocrServicesCreate: 0,
      ocrServicesUpdate: 0,
      ocrServicesCopy: 0,
      speechServicesCreate: 0,
      speechServicesUpdate: 0,
      speechServicesCopy: 0,
    },
    validationErrors: [],
    requiresAuthentication: ["p1"],
    integrationRequiresAuthentication: [],
    proxyRequiresAuthentication: false,
    defaultProfileCleared: false,
    previewId: "cfgimp_test-1",
    runtimeRequirements: [],
    ...overrides,
  };
}

function requirement(overrides: Partial<ImportRuntimeRequirementPreview> = {}): ImportRuntimeRequirementPreview {
  return {
    subjectKind: "provider",
    subjectId: "p1",
    displayLabel: "OpenAI",
    adapterId: "openai-compatible",
    runtimeKind: "wasm-component",
    pluginId: "com.langnext.provider.test",
    pluginVersion: "1.0.0",
    packageDigest: "a".repeat(64),
    publisherKeyId: "com.langnext.keys.1",
    publisherKeyFingerprint: "f".repeat(64),
    localStatus: "installed",
    requiredAction: "activate_after_import",
    ...overrides,
  };
}

describe("importGraphCountSummaries", () => {
  test("returns create/update/copy counts per graph category with stable label keys", () => {
    const summaries = importGraphCountSummaries(preview());
    const providers = summaries.find((s) => s.kind === "providers");
    expect(providers).toEqual({
      kind: "providers",
      create: 1,
      update: 2,
      copy: 0,
      labelKey: "settings.backup.countProviders",
    });
    const models = summaries.find((s) => s.kind === "models");
    expect(models?.create).toBe(3);
    const profiles = summaries.find((s) => s.kind === "profiles");
    expect(profiles?.copy).toBe(4);
    const integrations = summaries.find((s) => s.kind === "integrations");
    expect(integrations?.update).toBe(1);
  });

  test("omits categories with no changes", () => {
    const summaries = importGraphCountSummaries(preview());
    expect(summaries.find((s) => s.kind === "ocrServices")).toBeUndefined();
    expect(summaries.find((s) => s.kind === "speechServices")).toBeUndefined();
  });
});

describe("importAuthenticationCategories", () => {
  test("reports each credential domain that needs re-entry", () => {
    const categories = importAuthenticationCategories(
      preview({
        requiresAuthentication: ["p1", "p2"],
        integrationRequiresAuthentication: ["i1"],
        ocrRequiresAuthentication: ["o1"],
        proxyRequiresAuthentication: true,
      }),
    );
    expect(categories).toEqual(["providers", "integrations", "ocr", "proxy"]);
  });

  test("reports only proxy for a proxy-only preview", () => {
    expect(
      importAuthenticationCategories(
        preview({
          requiresAuthentication: [],
          integrationRequiresAuthentication: [],
          ocrRequiresAuthentication: [],
          proxyRequiresAuthentication: true,
        }),
      ),
    ).toEqual(["proxy"]);
  });

  test("reports nothing when no credentials are needed", () => {
    expect(
      importAuthenticationCategories(
        preview({
          requiresAuthentication: [],
          integrationRequiresAuthentication: [],
          proxyRequiresAuthentication: false,
        }),
      ),
    ).toEqual([]);
  });
});

describe("importAuthenticationCategoryLabelKey", () => {
  test("maps every category to a stable label key", () => {
    expect(importAuthenticationCategoryLabelKey("providers")).toBe("settings.backup.importAuthProviders");
    expect(importAuthenticationCategoryLabelKey("integrations")).toBe("settings.backup.importAuthIntegrations");
    expect(importAuthenticationCategoryLabelKey("ocr")).toBe("settings.backup.importAuthOcr");
    expect(importAuthenticationCategoryLabelKey("proxy")).toBe("settings.backup.importAuthProxy");
  });
});

describe("importModeLabelKey", () => {
  test("maps merge and copy to stable label keys", () => {
    expect(importModeLabelKey("merge")).toBe("settings.backup.importModeMerge");
    expect(importModeLabelKey("copy")).toBe("settings.backup.importModeCopy");
  });
});

describe("importRuntimeDetailRows", () => {
  test("returns exact labeled identity rows for a package-backed entry", () => {
    const rows = importRuntimeDetailRows(requirement());
    const byLabel = new Map(rows.map((row) => [row.labelKey, row]));
    expect(byLabel.get("settings.backup.runtimeDetailAdapter")?.value).toBe("openai-compatible");
    expect(byLabel.get("settings.backup.runtimeDetailRuntime")?.value).toBe("wasm-component");
    expect(byLabel.get("settings.backup.runtimeDetailPluginId")?.value).toBe("com.langnext.provider.test");
    expect(byLabel.get("settings.backup.runtimeDetailPluginVersion")?.value).toBe("1.0.0");
    expect(byLabel.get("settings.backup.runtimeDetailPackageDigest")?.value).toBe("a".repeat(64));
    expect(byLabel.get("settings.backup.runtimeDetailPublisherKeyId")?.value).toBe("com.langnext.keys.1");
    expect(byLabel.get("settings.backup.runtimeDetailPublisherFingerprint")?.value).toBe("f".repeat(64));
    expect(byLabel.get("settings.backup.runtimeDetailStatus")).toEqual({
      labelKey: "settings.backup.runtimeDetailStatus",
      value: "settings.backup.runtimeStatusInstalled",
      valueIsLabelKey: true,
    });
    expect(byLabel.get("settings.backup.runtimeDetailAction")?.value).toBe(
      "settings.backup.runtimeActionActivateAfterImport",
    );
  });

  test("omits absent adapter, plugin, and publisher fields", () => {
    const rows = importRuntimeDetailRows(
      requirement({
        adapterId: null,
        pluginId: null,
        pluginVersion: null,
        packageDigest: null,
        publisherKeyId: null,
        publisherKeyFingerprint: null,
      }),
    );
    const labels = rows.map((row) => row.labelKey);
    expect(labels).not.toContain("settings.backup.runtimeDetailAdapter");
    expect(labels).not.toContain("settings.backup.runtimeDetailPluginId");
    expect(labels).not.toContain("settings.backup.runtimeDetailPluginVersion");
    expect(labels).not.toContain("settings.backup.runtimeDetailPackageDigest");
    expect(labels).not.toContain("settings.backup.runtimeDetailPublisherKeyId");
    expect(labels).not.toContain("settings.backup.runtimeDetailPublisherFingerprint");
    expect(labels).toContain("settings.backup.runtimeDetailRuntime");
    expect(labels).toContain("settings.backup.runtimeDetailStatus");
    expect(labels).toContain("settings.backup.runtimeDetailAction");
  });

  test("never truncates or recomputes identifiers", () => {
    const entry = requirement();
    const rows = importRuntimeDetailRows(entry);
    const digest = rows.find((row) => row.labelKey === "settings.backup.runtimeDetailPackageDigest");
    expect(digest?.value).toBe(entry.packageDigest);
    const fingerprint = rows.find((row) => row.labelKey === "settings.backup.runtimeDetailPublisherFingerprint");
    expect(fingerprint?.value).toBe(entry.publisherKeyFingerprint);
  });
});

describe("runtime status/action label keys", () => {
  test("maps every closed local status to a stable label key", () => {
    const statuses: ImportRuntimeLocalStatus[] = [
      "bundled",
      "legacy",
      "missing",
      "revoked",
      "disabled",
      "content_unavailable",
      "incompatible",
      "installed",
    ];
    for (const status of statuses) {
      expect(importRuntimeStatusLabelKey(status)).toStartWith("settings.backup.runtimeStatus");
    }
  });

  test("maps every closed action to a stable label key", () => {
    const actions: ImportRuntimeRequiredAction[] = [
      "none",
      "install_exact_package",
      "restore_publisher",
      "resolve_incompatibility",
      "activate_after_import",
    ];
    for (const action of actions) {
      expect(importRuntimeActionLabelKey(action)).toStartWith("settings.backup.runtimeAction");
    }
  });
});

describe("groupImportRuntimeRequirements", () => {
  test("groups entries by required action in closed display order", () => {
    const groups = groupImportRuntimeRequirements([
      requirement({ displayLabel: "A", requiredAction: "install_exact_package" }),
      requirement({ displayLabel: "B", requiredAction: "activate_after_import" }),
      requirement({ displayLabel: "C", requiredAction: "none" }),
      requirement({ displayLabel: "D", requiredAction: "install_exact_package" }),
    ]);
    // Only actions with entries appear, in the closed display order.
    expect(groups.map((g) => g.action)).toEqual(["none", "install_exact_package", "activate_after_import"]);
    const install = groups.find((g) => g.action === "install_exact_package");
    expect(install?.items.map((i) => i.displayLabel)).toEqual(["A", "D"]);
  });

  test("treats missing entries as empty", () => {
    expect(groupImportRuntimeRequirements(undefined)).toEqual([]);
  });
});

describe("importHasPackageBackedRuntimes", () => {
  test("is true when any requirement needs an action beyond none", () => {
    expect(importHasPackageBackedRuntimes([requirement({ requiredAction: "install_exact_package" })])).toBe(true);
  });

  test("is false when every requirement is bundled/legacy", () => {
    expect(
      importHasPackageBackedRuntimes([
        requirement({ localStatus: "bundled", requiredAction: "none" }),
        requirement({ localStatus: "legacy", requiredAction: "none" }),
      ]),
    ).toBe(false);
  });
});

describe("inactive runtime copy", () => {
  test("exposes a stable i18n key for the inactive-after-import note", () => {
    expect(IMPORT_INACTIVE_RUNTIME_COPY_KEY).toBe("settings.backup.importRuntimeInactive");
  });
});
