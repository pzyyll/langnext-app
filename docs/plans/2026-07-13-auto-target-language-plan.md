# Auto Target Language Implementation Plan

**Goal:** Add profile-level Primary and Target language preferences and resolve an output language configured as Auto from the effective source language.

**Inputs:** Mr. Julian's requirements for `src/routes/translate/`, the existing source-language Auto detection flow, and the reference behavior in STranslate.

**Assumptions:**

- “profile” means the existing Translation Profile edited in `src/routes/translate/profiles.tsx`, not global application settings.
- Primary and Target are concrete supported language IDs; neither may be `auto`, and they must differ.
- A new profile defaults Primary from the UI locale (`zh-CN` → `zh`, otherwise `en`). Target defaults to `en`, except when Primary is `en`, where Target defaults to `zh` so the exclusion rule remains valid.
- Existing profiles and imported legacy profiles may initially omit the two new fields; the UI derives the same defaults until the profile is saved.
- Source-language detection failure keeps the current behavior and aborts translation.

**Architecture:** Keep source detection and Auto target resolution in the frontend request preparation flow, because that layer has the effective source language ID before labels are sent to Rust. Persist profile preferences as nullable backward-compatible columns and DTO fields, validate them authoritatively in the Rust profile service, and share the language policy between the translation page and profile editor through a small pure TypeScript module.

**Tech Stack:** React 19, TypeScript, Bun tests, Tauri 2, Rust, SQLite migrations, i18next.

---

## File Map

- Create: `src/routes/translate/languages.ts` — shared supported-language types, defaults, guards, and Auto target resolver.
- Create: `src/routes/translate/languages.test.ts` — policy tests for defaults, exclusions, and target resolution.
- Create: `src-tauri/migrations/0006_profile_language_preferences.sql` — nullable profile preference columns for backward compatibility.
- Modify: `src/routes/translate/index.tsx` — target Auto option, effective target resolution, profile preference consumption, and swap behavior.
- Modify: `src/routes/translate/profiles.tsx` — Primary/Target preference controls, valid defaults, and target Auto support.
- Modify: `src/storage/types.ts` — profile DTO/write fields for `primaryLang` and `preferredTargetLang`.
- Modify: `src/i18n/locales/en.ts` — concise English labels and validation copy.
- Modify: `src/i18n/locales/zh-CN.ts` — concise Chinese labels and validation copy.
- Modify: `src-tauri/src/domain/translation_profile.rs` — serialized profile preference fields.
- Modify: `src-tauri/src/repositories/translation_profiles.rs` — read/write the new columns.
- Modify: `src-tauri/src/services/translation_profiles.rs` — validate supported concrete IDs and enforce Primary ≠ Target.
- Modify: `src-tauri/src/services/import_validation.rs` — reject invalid imported preference pairs while accepting omitted legacy fields.
- Modify: `src-tauri/src/storage/migrations.rs` — register migration 0006 and verify its columns.
- Modify: `src-tauri/src/storage/tests.rs` — migration/persistence coverage where existing fixtures require the new schema.
- Modify: `src-tauri/src/repositories/tests.rs` — repository round-trip coverage for both preference fields.
- Modify: `src-tauri/src/services/tests.rs` — create/update/import validation coverage.

## Decision Rule

Given effective source language `source`, configured output selector `configuredTarget`, profile Primary `primary`, and profile Target preference `preferredTarget`:

1. If `configuredTarget` is a concrete language, use it unchanged.
2. If `configuredTarget` is `auto` and `source !== preferredTarget`, use `preferredTarget`.
3. If `configuredTarget` is `auto` and `source === preferredTarget`, use `primary`.

The resolver must return a concrete language ID. `primary === preferredTarget` is invalid profile data and must be blocked by both UI constraints and Rust service validation.

## Tasks

### Task 1: Add the shared language policy

**Outcome:** Language IDs, profile defaults, and Auto target behavior have one tested implementation.

**Files:**

- Create: `src/routes/translate/languages.ts`
- Create: `src/routes/translate/languages.test.ts`

**Steps:**

- [ ] Move the duplicated supported language ID tuple and related TypeScript types into the shared module.
- [ ] Export a concrete-language guard and a selectable language type that includes `auto`.
- [ ] Add `getDefaultProfileLanguages(uiLanguage)` with `zh-CN → { primary: "zh", target: "en" }` and English/unknown locale → `{ primary: "en", target: "zh" }`.
- [ ] Add a pure `resolveTargetLanguage` implementing the three decision rules above and rejecting or safely guarding invalid equal preferences.
- [ ] Cover manual target, Auto with a non-Target source, Auto with a Target-matching source, locale defaults, and the exclusion invariant.

**Validation:**

- Run: `bun test src/routes/translate/languages.test.ts`
- Expected: All language policy tests pass.

### Task 2: Persist and validate profile language preferences

**Outcome:** Translation Profiles can round-trip Primary and Target preferences without breaking old databases or exports.

**Files:**

- Create: `src-tauri/migrations/0006_profile_language_preferences.sql`
- Modify: `src-tauri/src/domain/translation_profile.rs`
- Modify: `src-tauri/src/repositories/translation_profiles.rs`
- Modify: `src-tauri/src/services/translation_profiles.rs`
- Modify: `src-tauri/src/services/import_validation.rs`
- Modify: `src-tauri/src/storage/migrations.rs`
- Modify: `src-tauri/src/storage/tests.rs`
- Modify: `src-tauri/src/repositories/tests.rs`
- Modify: `src-tauri/src/services/tests.rs`
- Modify: `src/storage/types.ts`

**Steps:**

- [ ] Add nullable `primary_lang` and `preferred_target_lang` columns so existing rows remain readable.
- [ ] Add optional camelCase DTO/write fields `primaryLang` and `preferredTargetLang`, using serde defaults for legacy imports.
- [ ] Include both columns in every profile SELECT, INSERT, UPDATE, export, and import path.
- [ ] Validate that supplied preference IDs are in the supported concrete language set, neither is `auto`, both are supplied together for new writes, and they differ.
- [ ] Continue accepting legacy persisted/imported profiles where both fields are absent; normalize them in the editor before the next save.
- [ ] Extend migration, repository, service, and import tests for valid round trips, equal-language rejection, unsupported ID rejection, and omitted legacy fields.

**Validation:**

- Run: `cargo test --manifest-path src-tauri/Cargo.toml translation_profiles`
- Expected: Profile repository and service tests pass, including the new preference invariants.
- Run: `cargo test --manifest-path src-tauri/Cargo.toml migrate_`
- Expected: Migration tests reach version 6 and preserve existing profile data.

### Task 3: Add Profile controls and target Auto configuration

**Outcome:** Users can configure a profile's Primary, Target preference, and output selector without creating an invalid preference pair.

**Files:**

- Modify: `src/routes/translate/profiles.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh-CN.ts`

**Steps:**

- [ ] Replace local duplicated language types with imports from `languages.ts`.
- [ ] Allow `targetLang` to select `auto`, while Primary and Target preference selectors only offer concrete languages.
- [ ] Initialize new and legacy profile drafts from the current UI locale using `getDefaultProfileLanguages`.
- [ ] Add concise Primary and Target controls near the existing source/target language controls.
- [ ] Disable the currently selected counterpart in each preference selector and show a validation error if malformed imported data still produces an equal pair.
- [ ] Include both preference IDs in profile create/update payloads.
- [ ] Preserve existing source/target and detector settings when editing profiles.

**Validation:**

- Run: `mise run typecheck`
- Expected: Profile draft, DTO, and selector types compile without casts that permit invalid `auto` preferences.
- Run: `mise run lint`
- Expected: No new ESLint errors.

### Task 4: Resolve Auto target before translation

**Outcome:** Translation requests always send a concrete target label selected by the required profile rule.

**Files:**

- Modify: `src/routes/translate/index.tsx`

**Steps:**

- [ ] Import the shared language types, guard, defaults, and resolver.
- [ ] Add `auto` to the output language selector and retain `auto` as UI state rather than replacing it after each request.
- [ ] When a profile is applied, load its Primary and Target preferences, falling back from the current UI locale for legacy profiles.
- [ ] In `handleTranslate`, first resolve the effective source ID from the manual selection or existing detector call, then resolve the effective target ID with `resolveTargetLanguage`.
- [ ] Convert only the effective concrete source and target IDs to localized labels for the Rust translation payload; never send the label `Auto`.
- [ ] Update swap behavior to use effective concrete languages when either selector is Auto and a detected source is available; otherwise keep the current safe no-op behavior when no effective source exists.
- [ ] Keep manually selected concrete targets unchanged, even when they equal the source, because the new fallback rule applies only to configured output Auto.

**Validation:**

- Run: `bun test src/routes/translate/languages.test.ts`
- Expected: Resolver behavior remains green.
- Run: `mise run typecheck`
- Expected: Translation state and payload construction compile with concrete target guarantees.

### Task 5: Run full project validation

**Outcome:** Frontend and Rust changes are formatted and pass the repository's supported checks.

**Files:**

- Modify only files changed by the formatter when required.

**Steps:**

- [ ] Format the touched frontend and Rust files using the project tasks.
- [ ] Run frontend tests, type checking, lint, and format checks.
- [ ] Run the Rust test suite to catch migration, repository, import, and service regressions.
- [ ] Review the final diff to confirm existing uncommitted Auto detection work was preserved and no generated route file was edited.

**Validation:**

- Run: `mise run test`
- Expected: Frontend and Rust tests pass.
- Run: `mise run typecheck`
- Expected: TypeScript reports no errors.
- Run: `mise run lint`
- Expected: ESLint reports no errors.
- Run: `mise run format:check`
- Expected: Prettier and cargo fmt report clean formatting.

## Final Validation

- Run: `mise run test && mise run typecheck && mise run lint && mise run format:check`
- Expected: Every command exits successfully.
- Manually verify the decision matrix in the running translate UI:
  - Primary `zh`, Target `en`, output Auto, source `ja` → effective target `en`.
  - Primary `zh`, Target `en`, output Auto, source `en` → effective target `zh`.
  - Primary `en`, Target `zh`, output Auto, source `fr` → effective target `zh`.
  - Primary `en`, Target `zh`, output Auto, source `zh` → effective target `en`.
  - Any concrete output selection → that language is sent unchanged.

## Rollout Notes

- Migration 0006 only adds nullable columns and is backward-compatible with existing rows.
- Legacy profile exports without the fields remain importable; newly saved/exported profiles include them.
- The current working tree already contains uncommitted source Auto detection changes in the same files. Implementation must be incremental in the current worktree and must not reset, overwrite, stage, or commit those changes.

## Risks and Mitigations

- Profile terminology can be confused with global app settings — keep both fields exclusively on Translation Profile DTOs and UI.
- Localized labels are currently sent to the Rust prompt — resolve IDs before localization so `Auto` never reaches the backend.
- UI-locale defaults can violate Target=`en` when the UI is English — the exclusion invariant takes precedence and uses `zh` as the deterministic alternate.
- Existing profile fixtures touch wide Rust surfaces — update fixtures narrowly and rely on full Rust tests to catch missing repository columns.
- Swap semantics become ambiguous with Auto on both sides — derive concrete effective languages only when detection exists; otherwise do nothing rather than guessing.
