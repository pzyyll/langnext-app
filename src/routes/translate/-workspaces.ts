// ABOUTME: Translate page workspaces: per-tab presets, languages, and draft text.
// ABOUTME: localStorage-backed store with safe normalize + migration from session prefs.
import {
  isLanguageId,
  isSelectableLanguageId,
  type LanguageId,
  type SelectableLanguageId,
  type SourceLanguageId,
} from "./-languages";
import { getTranslateSessionPreferences, type TranslateSessionPreferences } from "./-sessionPreferences";

/** Namespaced key for the multi-workspace translate store. */
export const TRANSLATE_WORKSPACES_KEY = "langnext-translate-workspaces";

/** Schema version for future migrations of the stored document. */
export const TRANSLATE_WORKSPACES_VERSION = 1 as const;

/** Hard cap so a runaway create loop cannot bloat localStorage. */
export const MAX_TRANSLATE_WORKSPACES = 30;

/** Display-name length limit (Unicode code units; fine for UI names). */
export const MAX_WORKSPACE_NAME_LENGTH = 64;

/**
 * Soft cap per text field. localStorage is typically ~5 MiB; keep drafts usable
 * without letting one paste exhaust the quota for every other key.
 */
export const MAX_WORKSPACE_TEXT_LENGTH = 500_000;

export interface TranslateWorkspace {
  id: string;
  name: string;
  profileId: string;
  modelId: string;
  sourceLang: SourceLanguageId;
  targetLang: SelectableLanguageId;
  /** Empty string = profile default template. */
  promptTemplateId: string;
  sourceText: string;
  outputText: string;
  detectedSourceLang: LanguageId | null;
  confidencePercent: number;
  latencyMs: number | null;
  activeModelLabel: string | null;
  errorMessage: string | null;
  /** Epoch ms; used for stable ordering and dirty tracking. */
  updatedAt: number;
}

export interface TranslateWorkspacesStore {
  version: typeof TRANSLATE_WORKSPACES_VERSION;
  activeWorkspaceId: string;
  workspaces: TranslateWorkspace[];
}

export const DEFAULT_WORKSPACE_NAME = "Workspace 1";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string";
}

function clampText(value: string): string {
  if (value.length <= MAX_WORKSPACE_TEXT_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_WORKSPACE_TEXT_LENGTH);
}

function clampName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_WORKSPACE_NAME;
  }
  if (trimmed.length <= MAX_WORKSPACE_NAME_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_WORKSPACE_NAME_LENGTH);
}

function newWorkspaceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Build a blank workspace seeded from optional session-style prefs. */
export function createTranslateWorkspace(
  prefs?: Partial<TranslateSessionPreferences> & { name?: string; promptTemplateId?: string },
  now = Date.now(),
): TranslateWorkspace {
  const sourceLang = isSelectableLanguageId(prefs?.sourceLang) ? prefs.sourceLang : ("auto" as SourceLanguageId);
  const targetLang = isSelectableLanguageId(prefs?.targetLang) ? prefs.targetLang : ("en" as SelectableLanguageId);

  return {
    id: newWorkspaceId(),
    name: clampName(prefs?.name ?? DEFAULT_WORKSPACE_NAME),
    profileId: typeof prefs?.profileId === "string" ? prefs.profileId : "",
    modelId: typeof prefs?.modelId === "string" ? prefs.modelId : "",
    sourceLang,
    targetLang,
    promptTemplateId: typeof prefs?.promptTemplateId === "string" ? prefs.promptTemplateId : "",
    sourceText: "",
    outputText: "",
    detectedSourceLang: null,
    confidencePercent: 0,
    latencyMs: null,
    activeModelLabel: null,
    errorMessage: null,
    updatedAt: now,
  };
}

/** Normalize one workspace row; invalid shapes fall back field-by-field. */
export function normalizeTranslateWorkspace(raw: unknown, now = Date.now()): TranslateWorkspace | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!isNonEmptyString(record.id) || record.id.length === 0) {
    return null;
  }

  const sourceLang = isSelectableLanguageId(typeof record.sourceLang === "string" ? record.sourceLang : null)
    ? (record.sourceLang as SourceLanguageId)
    : ("auto" as SourceLanguageId);
  const targetLang = isSelectableLanguageId(typeof record.targetLang === "string" ? record.targetLang : null)
    ? (record.targetLang as SelectableLanguageId)
    : ("en" as SelectableLanguageId);
  const detected =
    typeof record.detectedSourceLang === "string" && isLanguageId(record.detectedSourceLang)
      ? record.detectedSourceLang
      : null;

  const confidenceRaw = record.confidencePercent;
  const confidencePercent =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
      : 0;

  const latencyRaw = record.latencyMs;
  const latencyMs =
    typeof latencyRaw === "number" && Number.isFinite(latencyRaw) && latencyRaw >= 0 ? Math.round(latencyRaw) : null;

  const updatedRaw = record.updatedAt;
  const updatedAt = typeof updatedRaw === "number" && Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : now;

  return {
    id: record.id,
    name: clampName(typeof record.name === "string" ? record.name : DEFAULT_WORKSPACE_NAME),
    profileId: typeof record.profileId === "string" ? record.profileId : "",
    modelId: typeof record.modelId === "string" ? record.modelId : "",
    sourceLang,
    targetLang,
    promptTemplateId: typeof record.promptTemplateId === "string" ? record.promptTemplateId : "",
    sourceText: clampText(typeof record.sourceText === "string" ? record.sourceText : ""),
    outputText: clampText(typeof record.outputText === "string" ? record.outputText : ""),
    detectedSourceLang: detected,
    confidencePercent,
    latencyMs,
    activeModelLabel: typeof record.activeModelLabel === "string" ? record.activeModelLabel : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    updatedAt,
  };
}

/**
 * Normalize a full store document. Guarantees at least one workspace and a valid
 * active id. When input is empty/invalid, seeds from legacy session preferences.
 */
export function normalizeTranslateWorkspacesStore(raw: unknown, now = Date.now()): TranslateWorkspacesStore {
  if (raw != null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const list = Array.isArray(record.workspaces) ? record.workspaces : null;
    if (list) {
      const workspaces: TranslateWorkspace[] = [];
      const seen = new Set<string>();
      for (const item of list) {
        if (workspaces.length >= MAX_TRANSLATE_WORKSPACES) {
          break;
        }
        const ws = normalizeTranslateWorkspace(item, now);
        if (!ws || seen.has(ws.id)) {
          continue;
        }
        seen.add(ws.id);
        workspaces.push(ws);
      }
      if (workspaces.length > 0) {
        const activeRaw = typeof record.activeWorkspaceId === "string" ? record.activeWorkspaceId : "";
        const activeWorkspaceId = workspaces.some((ws) => ws.id === activeRaw) ? activeRaw : workspaces[0]!.id;
        return {
          version: TRANSLATE_WORKSPACES_VERSION,
          activeWorkspaceId,
          workspaces,
        };
      }
    }
  }

  // First run or corrupt store: one workspace seeded from legacy session prefs.
  const session = getTranslateSessionPreferences();
  const workspace = createTranslateWorkspace(
    {
      name: DEFAULT_WORKSPACE_NAME,
      profileId: session.profileId,
      modelId: session.modelId,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
    },
    now,
  );
  return {
    version: TRANSLATE_WORKSPACES_VERSION,
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
  };
}

/** Read the workspaces store from localStorage; never throws. */
export function getTranslateWorkspacesStore(): TranslateWorkspacesStore {
  if (typeof window === "undefined") {
    return normalizeTranslateWorkspacesStore(null);
  }
  try {
    const stored = localStorage.getItem(TRANSLATE_WORKSPACES_KEY);
    if (stored == null || stored === "") {
      return normalizeTranslateWorkspacesStore(null);
    }
    return normalizeTranslateWorkspacesStore(JSON.parse(stored) as unknown);
  } catch {
    return normalizeTranslateWorkspacesStore(null);
  }
}

/** Persist the store; normalizes first and swallows quota/private-mode errors. */
export function setTranslateWorkspacesStore(store: TranslateWorkspacesStore): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = normalizeTranslateWorkspacesStore(store);
    localStorage.setItem(TRANSLATE_WORKSPACES_KEY, JSON.stringify(normalized));
  } catch {
    // Quota or private-mode failures must not break the page.
  }
}

/** Active workspace row, or the first workspace if the id is stale. */
export function getActiveWorkspace(store: TranslateWorkspacesStore): TranslateWorkspace {
  return store.workspaces.find((ws) => ws.id === store.activeWorkspaceId) ?? store.workspaces[0]!;
}

/** Replace one workspace by id; no-op when missing. */
export function updateWorkspaceInStore(
  store: TranslateWorkspacesStore,
  workspaceId: string,
  patch: Partial<Omit<TranslateWorkspace, "id">>,
  now = Date.now(),
): TranslateWorkspacesStore {
  const workspaces = store.workspaces.map((ws) => {
    if (ws.id !== workspaceId) {
      return ws;
    }
    const next: TranslateWorkspace = {
      ...ws,
      ...patch,
      id: ws.id,
      updatedAt: now,
    };
    // Re-normalize through the field clamps without losing the id.
    return normalizeTranslateWorkspace(next, now) ?? { ...next, updatedAt: now };
  });
  return { ...store, workspaces };
}

/** Append a workspace and make it active (respects max count). */
export function addWorkspaceToStore(
  store: TranslateWorkspacesStore,
  workspace: TranslateWorkspace,
): TranslateWorkspacesStore {
  if (store.workspaces.length >= MAX_TRANSLATE_WORKSPACES) {
    return store;
  }
  if (store.workspaces.some((ws) => ws.id === workspace.id)) {
    return { ...store, activeWorkspaceId: workspace.id };
  }
  return {
    ...store,
    activeWorkspaceId: workspace.id,
    workspaces: [...store.workspaces, workspace],
  };
}

/**
 * Remove a workspace. If the last one is removed, recreate a blank default.
 * When deleting the active workspace, activate the neighbor (previous preferred).
 * `replacementName` localizes the recreated blank workspace when the list empties.
 */
export function removeWorkspaceFromStore(
  store: TranslateWorkspacesStore,
  workspaceId: string,
  now = Date.now(),
  replacementName = DEFAULT_WORKSPACE_NAME,
): TranslateWorkspacesStore {
  const index = store.workspaces.findIndex((ws) => ws.id === workspaceId);
  if (index < 0) {
    return store;
  }

  const remaining = store.workspaces.filter((ws) => ws.id !== workspaceId);
  if (remaining.length === 0) {
    const blank = createTranslateWorkspace({ name: replacementName }, now);
    return {
      version: TRANSLATE_WORKSPACES_VERSION,
      activeWorkspaceId: blank.id,
      workspaces: [blank],
    };
  }

  let activeWorkspaceId = store.activeWorkspaceId;
  if (activeWorkspaceId === workspaceId) {
    const neighbor = remaining[Math.max(0, index - 1)] ?? remaining[0]!;
    activeWorkspaceId = neighbor.id;
  }

  return {
    version: TRANSLATE_WORKSPACES_VERSION,
    activeWorkspaceId,
    workspaces: remaining,
  };
}

/** Suggest the next default name ("Workspace 2", …) based on existing names. */
export function nextDefaultWorkspaceName(workspaces: readonly TranslateWorkspace[]): string {
  const used = new Set(workspaces.map((ws) => ws.name.trim().toLowerCase()));
  let n = workspaces.length + 1;
  for (let attempt = 0; attempt < MAX_TRANSLATE_WORKSPACES + 5; attempt += 1) {
    const candidate = `Workspace ${n}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
    n += 1;
  }
  return `Workspace ${Date.now()}`;
}
