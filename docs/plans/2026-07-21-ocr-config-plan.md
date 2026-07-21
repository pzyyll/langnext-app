# OCR Config Implementation Plan

**Goal:** Ship a modular OCR configuration surface (Baidu OCR + AI OCR) with real SQLite/vault persistence, primary-nav entry, and left-list / right-editor UX — config only, no OCR invocation.

**Inputs:** `next-prompt.md`, `.stitch/ocr/*` (layout reference only), STranslate Baidu/OpenAI OCR plugins (field reference), and locked product decisions below.

**Assumptions:**

- Phase 1 does **not** call any OCR API; Save only persists configuration.
- OCR services are **local configuration** (like providers/profiles), but **import/export is out of Phase 1** (schema designed so secrets stay out of future export docs).
- AI OCR reuses existing `provider_models` rows; it does **not** store its own API key/base URL.
- Multiple instances of the same `providerType` are allowed; there is **no** global default/active OCR flag.
- Prompt templates for AI OCR use the same **system + user** shape as translation profiles.
- Stitch HTML is layout/IA reference only; tokens, spacing, and controls follow existing Base UI + Tailwind outline/frame styles.

**Architecture:** OCR services flow through migration → domain → repository → service (incl. dual-key vault for Baidu) → IPC → typed `storage/client` → TanStack Query → `/ocr` nested routes. Selection is URL-driven (`/ocr/$ocrServiceId`). Provider-type-specific config is validated in the service and stored as typed columns + child prompt-template rows (not opaque untyped blobs for Phase 1 fields). Future providers (Tencent/Aliyun/…) add a `provider_type` enum value, optional columns/migration, and a form module without rewriting the list shell.

**Tech Stack:** Tauri 2, Rust, rusqlite, OS credential vault (`keyring`), React 19, TanStack Router/Query, Base UI, Tailwind CSS v4, i18next, Bun tests, cargo tests.

---

## Locked Decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Navigation | New primary sidebar item **OCR** (not Settings subpage) |
| 2 | Field authority | **STranslate** for Baidu fields; stitch is style/layout reference only |
| 3 | Multi-instance | Same provider type may appear many times; **no** default OCR |
| 4 | AI prompt shape | system + user templates, multi-template list like Profiles |
| 5 | Phase 1 providers | `baidu`, `ai` only; others not offered in Add dialog |
| 6 | Phase 1 scope | Config UI + CRUD persistence only; no recognize/test-connection |
| 7 | Secrets | Baidu API Key + Secret Key in OS vault; never on DTOs/export |
| 8 | AI model source | Select from existing configured models (`listAllProviderModels` / enabled models) |
| 9 | Import/export | Out of Phase 1 |
| 10 | Reorder | Out of Phase 1 (append-only `sort_order` on create is fine) |
| 11 | Nav order | Translate → Profiles → History → Models → **OCR**; Settings remains footer |

### Baidu fields (STranslate)

| Field | Notes |
| --- | --- |
| `displayName` | Editable service name |
| `enabled` | Local form → Save |
| `apiKey` | Vault; password input; never re-read |
| `secretKey` | Vault; password input; never re-read |
| `action` | `accurate` \| `accurate_basic` \| `general` \| `general_basic` (default `accurate`) |
| Official link | Static help link to `https://ai.baidu.com/tech/ocr` (not stored) |

### AI OCR fields

| Field | Notes |
| --- | --- |
| `displayName` | Editable service name |
| `enabled` | Local form → Save |
| `providerModelId` | UUID of an existing `provider_models` row |
| `temperature` | Optional `f64`, `>= 0`; empty → app default `0.2` at save/read convention matching Profiles |
| `promptTemplates` | ≥1; each `{ id, name, systemTemplate, userTemplate }` |
| `defaultPromptTemplateId` | Must reference a template on this service |

Default AI OCR system/user templates (seed on create; user-editable):

```text
system:
You are an OCR engine. Extract text from the user's image exactly as it appears.
Rules:
- Output only the recognized text. No preface, labels, or explanations.
- Preserve line breaks, spacing, and reading order when possible.
- Do not translate, summarize, correct, or invent content.
- If the image has no readable text, output an empty response.

user:
Extract all text from the image.
```

(STranslate scanner wording is inspiration only; keep copy short and plain.)

---

## Out of Scope (Phase 1)

- OCR API calls, screenshot → OCR pipeline, result overlay
- Tencent / Aliyun / WeChat / Google / OCR.Space forms (may appear greyed nowhere — simply omit)
- Connection test / “try recognize”
- Drag-reorder of OCR services
- Configuration import/export of OCR services
- Global “default OCR” or Active badge from stitch
- Stitch-only fields: App ID, region, timeout, retries, dedicated endpoint

---

## File Map

### Backend

- Create: `src-tauri/migrations/0010_ocr_services.sql` — tables + indexes
- Create: `src-tauri/src/domain/ocr_service.rs` — types, DTOs, writes, validation helpers
- Create: `src-tauri/src/repositories/ocr_services.rs` — SQL CRUD for services
- Create: `src-tauri/src/repositories/ocr_prompt_templates.rs` — SQL CRUD for AI templates
- Create: `src-tauri/src/services/ocr_services.rs` — validation, dual-key vault orchestration, DTO mapping
- Create: `src-tauri/src/cmds/ocr_services.rs` — Tauri commands
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0010
- Modify: `src-tauri/src/domain/mod.rs`
- Modify: `src-tauri/src/repositories/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/cmds/mod.rs`
- Modify: `src-tauri/src/lib.rs` — register commands
- Modify: `src-tauri/src/state.rs` — hold `OcrServiceService`
- Modify: `src-tauri/src/events.rs` — `data://ocr-services-changed`
- Modify: `src-tauri/src/credentials/refs.rs` — `ocr_api_key_ref`, `ocr_secret_key_ref`
- Modify: `src-tauri/src/repositories/credential_operations.rs` — `OwnerKind::OcrApiKey`, `OwnerKind::OcrSecretKey`
- Modify: `src-tauri/src/credentials/coordinator.rs` — `current_binding` for OCR owner kinds (read refs from `ocr_services` columns)
- Modify: `src-tauri/src/repositories/tests.rs` and/or `src-tauri/src/services/tests.rs` — CRUD + credential paths
- Modify: `src-tauri/src/credentials/tests.rs` if recovery paths need OCR owners

### Frontend

- Create: `src/routes/ocr.tsx` — parent layout route
- Create: `src/routes/ocr/index.tsx` — empty selection state
- Create: `src/routes/ocr/$ocrServiceId.tsx` — selected editor route
- Create: `src/features/ocr/OcrContext.ts` — list context + guarded hook
- Create: `src/features/ocr/OcrLayout.tsx` — left rail + outlet + add dialog trigger
- Create: `src/features/ocr/AddOcrServiceDialog.tsx` — provider type picker (Baidu / AI)
- Create: `src/features/ocr/OcrServiceEditor.tsx` — shared shell (name, enabled, footer, delete)
- Create: `src/features/ocr/BaiduOcrForm.tsx` — Baidu-specific fields
- Create: `src/features/ocr/AiOcrForm.tsx` — model, temperature, prompt templates
- Create: `src/features/ocr/ocrProviderOptions.ts` — creatable provider catalog for the dialog
- Create: `src/features/ocr/defaultAiOcrPrompt.ts` — default system/user strings
- Modify: `src/storage/types.ts` — OCR DTOs / writes
- Modify: `src/storage/client.ts` — IPC façades
- Modify: `src/query/keys.ts`, `options.ts`, `events.ts`, `QueryEventSync.tsx`, `registerDataChangeListeners.ts` (+ tests)
- Modify: `src/shell/nav.ts` — OCR nav item + icon id
- Modify: `src/routes/__root.tsx` — map new nav icon
- Modify: `src/i18n/locales/en.ts`, `zh-CN.ts`
- Generated: `src/routeTree.gen.ts` (router plugin only; never hand-edit)

---

## Data Model

### Migration `0010_ocr_services.sql`

```sql
-- ABOUTME: OCR service instances (Baidu + AI) and AI OCR prompt templates.
-- ABOUTME: Secrets live in the OS vault; only opaque refs are stored here.

CREATE TABLE ocr_services (
    id                          TEXT PRIMARY KEY,
    provider_type               TEXT NOT NULL
                                CHECK (provider_type IN ('baidu', 'ai')),
    display_name                TEXT NOT NULL,
    enabled                     INTEGER NOT NULL DEFAULT 1
                                CHECK (enabled IN (0, 1)),
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    -- Baidu-only (NULL for ai)
    baidu_action                TEXT
                                CHECK (
                                  baidu_action IS NULL OR baidu_action IN (
                                    'accurate',
                                    'accurate_basic',
                                    'general',
                                    'general_basic'
                                  )
                                ),
    api_key_ref                 TEXT,
    secret_key_ref              TEXT,
    -- AI-only (NULL for baidu)
    provider_model_id           TEXT,
    temperature                 REAL
                                CHECK (temperature IS NULL OR temperature >= 0),
    default_prompt_template_id  TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    CHECK (
      (provider_type = 'baidu'
        AND baidu_action IS NOT NULL
        AND provider_model_id IS NULL
        AND temperature IS NULL
        AND default_prompt_template_id IS NULL)
      OR
      (provider_type = 'ai'
        AND baidu_action IS NULL
        AND api_key_ref IS NULL
        AND secret_key_ref IS NULL
        AND provider_model_id IS NOT NULL
        AND default_prompt_template_id IS NOT NULL)
    )
);

CREATE INDEX idx_ocr_services_sort
    ON ocr_services(sort_order ASC, created_at ASC, id ASC);

CREATE TABLE ocr_prompt_templates (
    id                          TEXT PRIMARY KEY,
    ocr_service_id              TEXT NOT NULL,
    name                        TEXT NOT NULL,
    system_template             TEXT NOT NULL,
    user_template               TEXT NOT NULL,
    sort_order                  INTEGER NOT NULL CHECK (sort_order >= 0),
    FOREIGN KEY (ocr_service_id)
        REFERENCES ocr_services(id) ON DELETE CASCADE,
    UNIQUE (ocr_service_id, sort_order)
);

CREATE INDEX idx_ocr_prompt_templates_service
    ON ocr_prompt_templates(ocr_service_id, sort_order ASC);
```

**Notes:**

- No FK from `provider_model_id` → `provider_models` in Phase 1 (avoids delete-order coupling with providers). Service validates existence on AI save; missing model at read time surfaces as UI warning, not a crash.
- `default_prompt_template_id` has no FK (same insert-order reason as profiles); service enforces membership.
- Future providers: extend `provider_type` CHECK via new migration + nullable columns or a follow-up `config_json` if fields diverge heavily.

### Domain types (Rust / TS mirror)

```ts
export type OcrProviderType = "baidu" | "ai";

export type BaiduOcrAction =
  | "accurate"
  | "accurate_basic"
  | "general"
  | "general_basic";

export interface OcrPromptTemplate {
  id: string;
  name: string;
  systemTemplate: string;
  userTemplate: string;
}

/** Sanitized list/detail DTO — no vault refs, no secrets. */
export interface OcrServiceDto {
  id: string;
  providerType: OcrProviderType;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
  /** Baidu only; null for ai. */
  baiduAction: BaiduOcrAction | null;
  hasApiKey: boolean;
  hasSecretKey: boolean;
  /** AI only; null for baidu. */
  providerModelId: string | null;
  temperature: number | null;
  defaultPromptTemplateId: string | null;
  promptTemplates: OcrPromptTemplate[]; // empty for baidu
  createdAt: string;
  updatedAt: string;
}

export interface OcrServiceWrite {
  id?: string | null;
  providerType: OcrProviderType;
  displayName: string;
  enabled: boolean;
  /** Baidu required on baidu writes. */
  baiduAction?: BaiduOcrAction | null;
  apiKey?: CredentialUpdate; // default keep on update; replace/clear supported
  secretKey?: CredentialUpdate;
  /** AI required on ai writes. */
  providerModelId?: string | null;
  temperature?: number | null;
  defaultPromptTemplateId?: string | null;
  /** Full ordered list; required for ai (≥1). Ignored/empty for baidu. */
  promptTemplates?: OcrPromptTemplate[];
  /** Required on update. */
  expectedUpdatedAt?: string | null;
}
```

### IPC commands

| Command | Behavior |
| --- | --- |
| `list_ocr_services` | Ordered list DTOs (include templates for AI rows) |
| `get_ocr_service` | Single DTO by id |
| `save_ocr_service` | Create (`id` null) or update; emit `data://ocr-services-changed` |
| `delete_ocr_service` | Delete row (+ cascade templates), clear vault refs via coordinator; emit event |
| `set_ocr_service_enabled` | Optional thin helper; **prefer single Save path** like Profiles — implement only if list toggle is added. Phase 1: enable only via editor Save. |

Frontend façades in `src/storage/client.ts` match the command names above.

### Credential model (Baidu)

- Two independent vault bindings per service:
  - `api_key_ref` / `OwnerKind::OcrApiKey` / `ocr_api_key_ref(service_id, op_id)`
  - `secret_key_ref` / `OwnerKind::OcrSecretKey` / `ocr_secret_key_ref(service_id, op_id)`
- Each uses the existing journal: prepared → vault set → SQLite commit → finalize (mirror `ProviderService`).
- `CredentialUpdate` semantics per field:
  - `keep` — leave ref unchanged (create: means “no secret yet”)
  - `replace` — non-empty secret required
  - `clear` — drop vault entry + null ref
- DTO exposes only `hasApiKey` / `hasSecretKey`.
- Recovery at startup: extend provider-style recovery to scan unfinished OCR owner ops (or call `recover_owner` when touching a service).

### Validation rules (service)

**Common**

- `displayName` trim; non-empty; max 128 chars
- `providerType` immutable on update (reject type change)
- `expectedUpdatedAt` required and must match on update (optimistic concurrency → conflict error)

**Baidu**

- `baiduAction` required, one of four enums
- `providerModelId` / `temperature` / templates must be absent/empty
- Secrets optional at create (user may save incomplete config); no “must have keys” until OCR invoke (later)

**AI**

- `providerModelId` required; must exist in `provider_models`
- `promptTemplates.length >= 1`
- Each template: non-empty trimmed `name` (max 64); system/user strings allowed empty only if product later needs it — Phase 1: **both required non-empty after trim**
- `defaultPromptTemplateId` must be one of the submitted template ids
- No credential fields accepted (ignore or reject non-keep)

### Events / Query

- Backend: `OCR_SERVICES_CHANGED = "data://ocr-services-changed"`
- Frontend: `DATA_OCR_SERVICES_CHANGED` + `ocrKeys.all/list/detail`
- `QueryEventSync` / `registerDataChangeListeners` invalidate `ocrKeys.all` on event
- Local mutations also invalidate/setQueryData for snappy UI

---

## UI / Routes

### Navigation

```ts
// src/shell/nav.ts — primary order
Translate → Profiles → History → Models → OCR
// Settings stays footer-only
```

- `NavIconId` add `"document_scanner"` (or `ocr` mapped to `material-symbols-light/document-scanner-outline`)
- `exact: false` so `/ocr/$id` keeps OCR active
- i18n: `nav.ocr` → `"OCR"` / `"OCR"`

### Route tree

```text
/ocr                 → OcrLayout (sidebar + Outlet)
/ocr/                → empty state copy
/ocr/$ocrServiceId   → OcrServiceEditor
```

Selection state lives **only** in the URL (same rule as Models).

### Layout (`OcrLayout`)

Mirror `ModelsLayout` density (not stitch pixel values):

- Left rail (~`w-72` / existing sidebar token if one fits): title, short subtitle, scrollable list, bottom **Add** button
- List row: `displayName`, provider type badge (`Baidu` / `AI`), enabled dimming when disabled
- Click → `navigate({ to: "/ocr/$ocrServiceId", params: { ocrServiceId } })`
- Loading / error / empty list states with retry
- No Active badge, no service “ID: BD-…” chrome from stitch

### Add dialog

- Base UI Dialog
- Two cards only: **Baidu OCR**, **AI OCR**
- On confirm:
  1. Build create write with defaults (name, enabled true, baidu action `accurate` **or** AI defaults: first enabled model if any else leave model empty and let editor block Save, one default prompt template, temperature null)
  2. Prefer: dialog only chooses type → create immediately with safe defaults → navigate to new id (Models pattern).  
     **AI model default:** if no models exist, still create with a placeholder? → **No** — require at least one model in the dialog for AI, else show inline error “Add a model first” with link affordance text only (no auto-nav to Models unless trivial).
  3. Simpler locked rule: **create with defaults without requiring model**; editor Save validates model. Create AI row needs a temporary model id — **blocked by NOT NULL**.  
     **Resolution:** On AI create, if zero models, refuse create with validation message. If ≥1 model, pick first enabled model from `listAllProviderModels` (stable sort by provider then name); user can change later.
- Close only after successful create

### Editor shell

- Header: display name field + Enabled switch (local draft)
- Body: type-specific form
- Footer (match Profiles/Models footer rhythm):
  - Delete (confirm dialog)
  - Discard (reset draft from last DTO)
  - Save (mutation)

### Baidu form

- API Key password field + “stored” placeholder when `hasApiKey`
- Secret Key password field + “stored” placeholder when `hasSecretKey`
- Explicit clear actions per key (short labels: `Reset` / `Clear` per UI copy rules)
- Version select: four actions with plain labels (i18n):
  - Accurate
  - Accurate (basic)
  - General
  - General (basic)
- Help text for version (one short line from STranslate meaning)
- Official website link (external)

### AI form

- Model `SelectField` / `ComboboxField` from `allProviderModelsOptions()` (label: provider display + model name)
- Temperature number input; placeholder default `0.2`
- Prompt templates section: reuse Profiles interaction patterns (collapsible cards, rename, set default, add, delete last-one-guard)
- Seed collapsed-state helper only if needed; do not invent drag-reorder for templates in Phase 1 (append order = `sort_order`)

### Empty / not-found

- No selection: short hint to select or add a service
- Unknown id after load: not-found copy + link back to `/ocr`

---

## Tasks

### Task 1: Migration + domain types

**Outcome:** Fresh DB migrates to version 10; Rust domain types compile with serde camelCase DTOs.

**Files:**

- Create: `src-tauri/migrations/0010_ocr_services.sql`
- Create: `src-tauri/src/domain/ocr_service.rs`
- Modify: `src-tauri/src/storage/migrations.rs`, `src-tauri/src/domain/mod.rs`

**Steps:**

- [ ] Add SQL as specified; keep transaction-compatible (no `PRAGMA` inside)
- [ ] Define `OcrProviderType`, `BaiduOcrAction`, entities, `OcrServiceDto`, `OcrServiceWrite`, `OcrPromptTemplate`
- [ ] DTO mapping never includes `*_ref` fields; only `has_api_key` / `has_secret_key`
- [ ] Unit test: DTO JSON omits refs; action serde uses snake_case values matching SQL

**Validation:**

- Run: `cargo test -p langnext-app --lib domain::ocr_service` (adjust package/bin name to workspace actual) or full `cargo test` filter `ocr`
- Expected: pass; `PRAGMA user_version` after migrate = 10 in migration tests

### Task 2: Repository layer

**Outcome:** SQLite list/get/insert/update/delete + template replace work in repository tests.

**Files:**

- Create: `src-tauri/src/repositories/ocr_services.rs`, `ocr_prompt_templates.rs`
- Modify: `src-tauri/src/repositories/mod.rs`, repository tests

**Steps:**

- [ ] `list` order: `sort_order ASC, created_at ASC, id ASC`
- [ ] `insert` assigns `sort_order = max+1`
- [ ] `update_configuration` updates mutable columns + `updated_at`
- [ ] Templates: delete-all-for-service + insert ordered rows inside same UoW as service save
- [ ] Delete service cascades templates

**Validation:**

- Run: repository tests for ocr insert/list/update/delete
- Expected: pass

### Task 3: Credential refs + OwnerKind + coordinator

**Outcome:** Dual OCR vault bindings participate in the same crash-safe journal as providers.

**Files:**

- Modify: `credentials/refs.rs`, `credential_operations.rs`, `coordinator.rs`, related tests

**Steps:**

- [ ] Add ref builders and owner kinds
- [ ] `current_binding` reads `api_key_ref` / `secret_key_ref` from `ocr_services`
- [ ] Recovery paths include OCR owners when finalizing unfinished ops

**Validation:**

- Run: credential/coordinator tests including new cases for OCR dual keys
- Expected: pass; Debug/logs never print secret material

### Task 4: OcrService service + IPC

**Outcome:** Frontend-callable CRUD with validation and events.

**Files:**

- Create: `services/ocr_services.rs`, `cmds/ocr_services.rs`
- Modify: `services/mod.rs`, `cmds/mod.rs`, `state.rs`, `lib.rs`, `events.rs`

**Steps:**

- [ ] Implement `list`, `get`, `save` (create/update), `delete`
- [ ] Create defaults: baidu action `accurate`; AI seeds one prompt template + chosen model
- [ ] Update requires `expectedUpdatedAt`
- [ ] Emit `data://ocr-services-changed` on save/delete
- [ ] Wire `AppState.ocr_services`
- [ ] Register commands in `lib.rs` invoke handler list

**Validation:**

- Run: `cargo test` filters for ocr service validation (missing name, bad action, AI without templates, concurrency conflict, baidu credential replace/clear)
- Expected: pass

### Task 5: Frontend storage + Query wiring

**Outcome:** Typed client + keys/options/events ready for UI.

**Files:**

- Modify: `src/storage/types.ts`, `client.ts`, `src/query/*`, listener tests

**Steps:**

- [ ] Mirror DTOs/writes exactly (camelCase)
- [ ] `listOcrServices`, `getOcrService`, `saveOcrService`, `deleteOcrService`
- [ ] `ocrKeys`, `ocrListOptions`, `ocrDetailOptions`
- [ ] Event constant + Query invalidation
- [ ] Update `keys.test.ts` / `registerDataChangeListeners.test.ts`

**Validation:**

- Run: `mise run typecheck` and `bun test src/query`
- Expected: pass

### Task 6: Routes, nav, i18n shell

**Outcome:** `/ocr` reachable from sidebar with empty state.

**Files:**

- Create route files; modify `nav.ts`, `__root.tsx`, locales
- Generate: `routeTree.gen.ts` via `mise run dev` once

**Steps:**

- [ ] Add nav item and icon
- [ ] Parent layout can temporarily render a stub list until Task 7
- [ ] en + zh-CN strings for nav and empty page

**Validation:**

- Run: `mise run typecheck`
- Expected: pass; manual: sidebar shows OCR, route loads

### Task 7: List layout + Add dialog

**Outcome:** Users can create Baidu/AI services and open them by URL.

**Files:**

- Create: `OcrContext.ts`, `OcrLayout.tsx`, `AddOcrServiceDialog.tsx`, `ocrProviderOptions.ts`

**Steps:**

- [ ] Query list via `ocrListOptions`
- [ ] Add dialog type cards; create mutation; navigate to new id
- [ ] AI create requires ≥1 model (see rules above)
- [ ] Loading/error/empty rail states

**Validation:**

- Run: `mise run typecheck` + manual create both types
- Expected: list updates; URL `/ocr/<uuid>`

### Task 8: Baidu editor

**Outcome:** Baidu config editable and persisted with vault flags.

**Files:**

- Create: `OcrServiceEditor.tsx`, `BaiduOcrForm.tsx`

**Steps:**

- [ ] Draft state from DTO; reset on id/updatedAt change
- [ ] Credential UX matches Models token rules (keep/replace/clear; no accidental clear on empty input)
- [ ] Save sends full write + `expectedUpdatedAt`
- [ ] Discard restores draft
- [ ] Delete confirm → delete IPC → navigate `/ocr`

**Validation:**

- Run: typecheck; manual save with keys, reload app, confirm `hasApiKey`/`hasSecretKey` true and inputs empty with stored placeholders
- Expected: secrets never appear in network/devtools IPC payloads

### Task 9: AI editor + prompt templates

**Outcome:** AI OCR model, temperature, and multi-template CRUD match Profiles patterns.

**Files:**

- Create: `AiOcrForm.tsx`, `defaultAiOcrPrompt.ts`

**Steps:**

- [ ] Model select from Query `allProviderModelsOptions`
- [ ] Template list: add / remove (min 1) / rename / set default / expand-collapse
- [ ] Temperature optional parse (`>= 0`)
- [ ] Client-side validation messages via i18n before invoke
- [ ] Missing model id after model deletion: show inline warning; Save blocked until user picks another

**Validation:**

- Run: typecheck; manual multi-template save/reload
- Expected: order and default preserved

### Task 10: Polish, a11y, copy, final gates

**Outcome:** Ship-quality Phase 1 config surface.

**Steps:**

- [ ] Focus management in dialogs; `aria` labels for icon-only controls
- [ ] Toast on save/delete success/failure via existing `useToast` + `getIpcErrorMessage`
- [ ] No Effect imports under `src/components/*`; routes stay thin
- [ ] ABOUTME headers on every new code file
- [ ] `mise run format` / lint as needed

**Validation:**

- Run: `mise run typecheck`
- Run: `mise run lint`
- Run: `cargo test` (ocr-related + full if feasible)
- Run: `bun test` for touched frontend tests
- Expected: all green

---

## Final Validation

- Run: `mise run typecheck`
- Run: `mise run lint`
- Run: `cargo test`
- Run: targeted `bun test` for `src/query` and any new frontend tests
- Manual smoke:
  1. Sidebar OCR entry order after Models
  2. Create Baidu + AI (with ≥1 model)
  3. Edit, discard, save, delete
  4. Restart app — list and flags restore; secrets not visible
  5. Create second Baidu instance — both remain, no default badge

---

## Failure Behavior

| Case | Behavior |
| --- | --- |
| List IPC failure | Rail error + Retry; no fabricated rows |
| Save validation | Inline/toast error; keep dialog/editor open |
| Optimistic concurrency conflict | Error message; refetch detail/list; user re-applies |
| Vault unavailable | Backend `CredentialUnavailable` → sanitized IPC message; row not half-committed |
| AI create with zero models | Dialog error; no row created |
| Delete while editor open | Confirm → delete → `/ocr` empty state |
| Unknown route id | Not-found panel after list loaded |

---

## Privacy and Security

- API Key / Secret Key only in OS vault; SQLite stores opaque refs
- DTOs expose booleans only (`hasApiKey`, `hasSecretKey`)
- Never log form values, write payloads with secrets, or put secrets in Effect/IPC error messages
- Password inputs: `type="password"`, spellcheck off
- Future export must omit refs and secrets (document only; not built now)

---

## Rollout Notes

- Migration 0010 applies automatically on app start via existing migrator
- No settings default keys to change
- No capability/permission changes (no new plugins)
- `routeTree.gen.ts` must be regenerated and committed after route files land

---

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Dual-key vault complexity / partial failure | Reuse provider journal; sequential finalize; tests for replace/clear each key |
| AI model deleted under OCR service | No hard FK; validate on save; editor warning when missing |
| Scope creep into OCR invoke | Explicit out-of-scope; disable any test buttons if UI temptations appear |
| Large Profiles-like template UI in one file | Keep `AiOcrForm` separate; reuse class names/patterns, not a full shared abstraction unless duplication hurts |
| Import/export later needs shape | Typed columns + no secrets on DTO keep a clear export path |

---

## Open Questions

**None** for Phase 1 implementation. Deferred product items (not blockers):

- Phase 2: actual OCR invoke + language options if Baidu API requires them at call time
- Phase 2: config import/export for OCR services
- Phase 2: additional providers (Tencent, Aliyun, …)
- Phase 2: optional list enable toggle without opening editor
- Phase 2: drag-reorder

---

## Requirement Traceability

| Requirement | Plan coverage |
| --- | --- |
| Multi-provider modular design | `provider_type` + type-specific columns/forms; Add catalog extensible |
| Phase 1 Baidu + AI only | Locked decisions + Add dialog |
| Nav entry | Primary OCR item |
| Left list / right config | `/ocr` layout + `$ocrServiceId` |
| Add → type dialog → card → form → save | Tasks 7–9 |
| Baidu fields from STranslate | Locked Baidu table |
| AI model + multi prompt + temperature | Locked AI table + Task 9 |
| Config only, no invoke | Out of scope section |
| Stitch style not binding | Assumptions + UI section |
| Same type multi-instance, no default | Locked #3 |
| system+user prompts | Locked #4 |
