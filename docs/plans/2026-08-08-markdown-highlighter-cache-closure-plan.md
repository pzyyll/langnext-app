# Implementation Plan

**Goal:** Remove the remaining Markdown highlighter cache identity and in-flight lifecycle risks, preserve request coalescing, and close the Rust cache and repository validation gates without repeating completed work.

**Inputs:** The supplied cache review notes; `src/components/markdown/-codeHighlighter.ts`; `src/components/markdown/-codeHighlighter.test.ts`; `src-tauri/src/services/wasm_runtime/cache.rs`; repository task files; Shiki custom-theme guidance from `/shikijs/shiki`.

**Assumptions:**

- The approved frontend seam is the `CodeHighlighterPlugin` returned by `createMarkdownCodeHighlighter`. No test-only cache inspection API will be added.
- “Bound pending maps” means entries exist only for genuine pending work and are removed when that exact promise settles. A fixed entry cap cannot safely apply to unresolved requests without a concurrency, rejection, or cancellation product policy that the requirements do not define.
- The plugin API has no cancellation handle. Preserve caller-side stale-result handling and callback coalescing. Do not add cancellation or abort semantics.
- `src-tauri/src/services/wasm_runtime/cache.rs` is functionally complete. Modify it only if line-ending checks show a worktree mismatch. Do not rewrite its cache or identity logic.
- The requirements approve the seams below. No additional seam confirmation is required before execution.

**Architecture:** Resolve each theme to both its stable name and its original Shiki input. Use collision-safe tuple encoding for cache identities, and retain custom theme objects when creating a Shiki highlighter. Replace the separate callback and boolean in-flight maps with one promise-owned request registry. Register before reuse, store only settled success or failure results in bounded caches, and delete an entry in `finally` only when it still owns the same promise.

**Tech Stack:** TypeScript 7, Bun test, Streamdown `CodeHighlighterPlugin`, Shiki 3.23, Vite 8, Rust 1.96, Cargo, cargo-audit 0.22.2, mise, Git.

---

## Requirement Coverage

| Requirement                                              | Plan mapping                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Find the exact frontend implementation and tests         | Confirmed as `src/components/markdown/-codeHighlighter.ts` and `src/components/markdown/-codeHighlighter.test.ts`.             |
| Prevent `:` delimiter collisions                         | Task 1 uses JSON tuple encoding for `(language, light theme, dark theme)` and `(light theme, dark theme)`.                     |
| Preserve custom theme identity                           | Task 1 keeps each original `ThemeInput` object for Shiki initialization and uses its name only for identity and tokenization.  |
| Remove settled in-flight entries in `finally`            | Task 1 consolidates pending state into promise-owned request records and performs identity-safe cleanup in `finally`.          |
| Preserve coalescing                                      | Task 1 reuses the exact registered request promise and callback set for duplicate pending requests.                            |
| Preserve cancellation/stale-result behavior              | Task 1 does not add an abort policy or change the plugin callback API; existing callback isolation tests remain authoritative. |
| Keep settled caches bounded                              | Task 1 retains the existing success, failure, and highlighter LRU limits and tests.                                            |
| Do not duplicate the Rust cache work                     | Task 2 verifies existing Rust behavior and changes only line endings when evidence requires it.                                |
| Run frontend, Rust, build, warning, and audit validation | Task 3 runs the complete gate and defines required advisory blocker evidence.                                                  |
| Verify staged and unstaged Rust cache state              | Tasks 2 and 3 run focused staged/unstaged diffs and `git ls-files --eol`.                                                      |

**Out of scope:** New cancellation APIs, aborting unresolved Shiki work, changing cache capacities, rewriting the Rust compiled-component cache, dependency upgrades without an audit finding, and unrelated cleanup.

## File Map

- Modify: `src/components/markdown/-codeHighlighter.ts` — use collision-safe theme/highlighter identities, retain custom theme inputs, and make pending request ownership promise-based.
- Test: `src/components/markdown/-codeHighlighter.test.ts` — add custom-theme delimiter collision coverage and retain public coalescing, retry, failure, and LRU behavior coverage.
- Conditional modify/test: `src-tauri/src/services/wasm_runtime/cache.rs` — normalize only its line endings if Git reports a mismatch; retain the existing bounded LRU and deterministic identity tests.
- Verify: `src-tauri/src/services/wasm_runtime/mod.rs` — confirm the cache module remains exported; no change expected.
- Verify: `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` — audit inputs; no change unless a separate evidence-backed advisory remediation is approved.
- Verify: `vite.config.ts` — existing Vite/Rolldown warning configuration; no change expected.
- Verify: `.mise/tasks/test-frontend`, `.mise/tasks/typecheck`, `.mise/tasks/build`, `.mise/tasks/test`, `.mise/tasks/audit/cargo`, and `.mise/tasks/format/check` — authoritative validation commands; no change expected.

## Seams

- **Seam:** `createMarkdownCodeHighlighter().highlight(options, callback)` — different custom theme tuples remain independent even when their names produce the same colon-concatenated text.
- **Seam:** `createMarkdownCodeHighlighter().highlight(options, callback)` — duplicate pending requests share work and callbacks, settled requests leave no stale pending owner, failed requests retain the existing bounded failure-cache behavior, and evicted requests can run again.
- **Seam:** `component_cache_identity` and `CompiledComponentCache::{insert, lookup, clear, len}` — the Rust cache remains deterministic, bounded, LRU-evicting, and disposable.
- **Seam:** repository validation tasks and Git file-state commands — frontend, Rust, build warnings, formatting, audit status, diffs, and line endings produce explicit pass or blocker evidence.

## Tasks

### Task 1: Make Highlighter Requests Collision-Safe and Promise-Owned

**Seam:** `createMarkdownCodeHighlighter().highlight(options, callback)`

**Outcome:** Custom theme names containing `:` cannot alias another theme tuple. Duplicate pending requests still coalesce. Every pending request record is removed by the `finally` handler of its exact promise. Only successful and failed settled outcomes enter the existing bounded caches.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add a test named `separates custom theme tuples whose colon-joined names collide` under `createMarkdownCodeHighlighter request identity` in `src/components/markdown/-codeHighlighter.test.ts`.
- [ ] Define four minimal Shiki custom theme objects with independent literal token colors. Use the two tuples `['pair:a', 'tail']` and `['pair', 'a:tail']`; both produce the old text `javascript:pair:a:tail` when joined with `:`.
- [ ] Submit one JavaScript request per tuple through `plugin.highlight`. Wait for both public callbacks. Assert that both callbacks run and that each result contains its tuple’s independently defined light and dark token colors. Do not read module-private maps.
- [ ] Run the focused test file before implementation. Confirm that the new test fails because the current code discards custom theme objects and aliases the highlighter promise through `highlighterCacheKey`.
- [ ] **Green:** Introduce a small internal resolved-theme value that contains `name: string` and `input: ThemeInput`. For a string theme, use the same string for both fields. For an object theme, keep the object in `input` and derive `name` with the existing fallback rule.
- [ ] Replace `themeCacheKey` with `JSON.stringify([lightName, darkName])`. Replace `highlighterCacheKey` with `JSON.stringify([language, lightName, darkName])`. Do not use `:` or `\0` delimiters for tuple identities.
- [ ] Pass the original resolved theme inputs to `createHighlighter({ langs: [language], themes: [...] })`. Continue to pass resolved theme names to `codeToTokens`.
- [ ] Replace `inflightCallbacks` and `inflightLoads` with one nested `inflightRequests` registry keyed by canonical language, collision-safe theme tuple, and full code string. Each leaf contains the pending `Promise<void>` and its `Set<HighlightCallback>`.
- [ ] In `queueHighlight`, look up the pending request first. If it exists, add the optional callback and return its exact promise without starting Shiki work.
- [ ] For a new request, construct the promise chain, create its request record, and register the record before any `.then` handler can run. Keep the existing JavaScript microtask ordering explicit in a short comment.
- [ ] On success, write the token result through `rememberSuccess` and invoke the callbacks owned by that request. On failure, write through `rememberFailure`, discard that request’s callbacks, preserve the existing error log shape, and remove a rejected highlighter promise only if `highlighterByKey` still contains that exact promise.
- [ ] Add a terminal `.finally` that retrieves the current request record and deletes/prunes it only when `current?.promise === promise`. An older promise must not delete a later request registered for the same identity.
- [ ] Keep `MAX_TOKEN_CACHE_ENTRIES`, `MAX_FAILED_CACHE_ENTRIES`, and `MAX_HIGHLIGHTER_CACHE_ENTRIES` unchanged. Do not store unresolved requests in any settled LRU cache.
- [ ] Update the existing in-flight tests only where their setup must use resolved theme inputs. Retain these public behavior checks without adding private cache access: identical requests share one loader/result, failed callbacks do not survive a retry, evicted successful requests run again, evicted failures retry, and highlighter LRU eviction reloads the evicted pair.
- [ ] Run the full highlighter test file after implementation.

**Validation:**

- Run (red): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected: the new custom-theme collision test fails because at least one callback does not return the independently themed result under the old key and theme-loading path.
- Run (green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected: all tests pass, including custom-theme tuple separation, duplicate pending request coalescing, success/failure eviction, stale callback removal, and highlighter promise LRU behavior.
- Run: `mise run typecheck`
- Expected: TypeScript accepts the resolved theme inputs and promise-owned request types with no errors.

### Task 2: Verify the Rust Cache and Correct Only Its Line Endings

**Seam:** `component_cache_identity`, `CompiledComponentCache`, and the Git representation of `src-tauri/src/services/wasm_runtime/cache.rs`

**Outcome:** The existing Rust implementation remains unchanged when it is already correct. If only the worktree line ending is wrong, the file becomes LF without semantic changes. Focused Rust tests pass.

**Files:**

- Conditional modify/test: `src-tauri/src/services/wasm_runtime/cache.rs`
- Verify: `src-tauri/src/services/wasm_runtime/mod.rs`

**Steps:**

- [ ] Record pre-change evidence with `git status --short`, focused unstaged and staged diffs, and `git ls-files --eol` for `cache.rs`.
- [ ] Confirm from `cache.rs` that `CACHE_MAX_ENTRIES` remains `32`; `component_cache_identity` still includes package digest, artifact digest, host API, Wasmtime version, config revision, and target triple; and tests still cover deterministic identity, every security-relevant identity input, hit/miss, LRU eviction, disposal, and digest parsing.
- [ ] Confirm from `mod.rs` that `pub mod cache;` remains present.
- [ ] If Git reports `i/lf w/lf`, make no Rust source change.
- [ ] If Git reports a non-LF worktree or a whole-file newline-only diff, first prove that no semantic delta is hidden: the focused staged diff must be empty, and `git diff --ignore-space-at-eol --exit-code -- src-tauri/src/services/wasm_runtime/cache.rs` must succeed.
- [ ] **Green, conditional:** Normalize only `cache.rs` with `mise exec -- rustfmt --edition 2024 src-tauri/src/services/wasm_runtime/cache.rs`. Do not format or restore unrelated paths.
- [ ] Re-run the focused diffs and EOL command. Require `i/lf w/lf`. If the pre-existing diff contains semantic edits, do not overwrite them; report the evidence as a blocker for line-ending correction.
- [ ] Run the cache-focused Rust tests.

**Validation:**

- Run: `git status --short`
- Expected: the executor records the complete worktree state and does not attribute unrelated changes to this task.
- Run: `git diff -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: no semantic Rust cache change; before conditional normalization, any diff is newline-only.
- Run: `git diff --cached -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: no staged change. If output exists, stop before normalization and report it.
- Run: `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: `i/lf w/lf` after the task.
- Run: `mise run test wasm_runtime::cache::tests`
- Expected: all focused cache identity and bounded LRU tests pass.

### Task 3: Run the Complete Closure Gate

**Seam:** repository validation tasks, Vite build output, cargo-audit report, and focused Git state

**Outcome:** Frontend tests, type checking, production build, warning gate, Rust tests, formatting, security audit, and Git state are all verified. Any advisory or pre-existing file-state blocker has precise evidence.

**Files:**

- Verify: `src/components/markdown/-codeHighlighter.ts`
- Verify: `src/components/markdown/-codeHighlighter.test.ts`
- Verify: `src-tauri/src/services/wasm_runtime/cache.rs`
- Verify: `vite.config.ts`
- Verify: `.mise/tasks/test-frontend`
- Verify: `.mise/tasks/typecheck`
- Verify: `.mise/tasks/build`
- Verify: `.mise/tasks/test`
- Verify: `.mise/tasks/audit/cargo`
- Verify: `.mise/tasks/format/check`
- Generated by validation and normally ignored: `.audit/cargo-audit.json`, `.audit/cargo-audit.stderr`

**Steps:**

- [ ] Run the raw full frontend command requested by the review, then run the repository-isolated frontend task. Both must pass.
- [ ] Run type checking and the production build. Inspect the complete Vite output, not only the exit status. The existing `PLUGIN_TIMINGS` suppression in `vite.config.ts` must not hide other warnings. Treat any unexpected warning as a failed warning gate and capture its exact text and originating plugin/file.
- [ ] Run the full Rust test task.
- [ ] Run lint and formatting checks.
- [ ] Run the mise-managed cargo audit task. Use this task instead of a machine-global `cargo audit`; `mise.toml` pins cargo-audit 0.22.2, and the task audits `src-tauri/Cargo.lock` while preserving JSON evidence.
- [ ] If the audit passes, record the zero exit status and continue.
- [ ] If the audit reports an advisory with a patched version, do not silently waive it or make a speculative broad upgrade. Record the advisory and dependency path, then require a focused dependency-remediation plan before claiming this closure gate passes.
- [ ] If the audit reports an unpatched advisory, stop the closure gate and provide precise blocker evidence: cargo-audit exit status; RustSec advisory ID and URL; affected crate and resolved version; advisory title and severity when present; `patched_versions`; `unaffected_versions`; the inverse dependency path printed by `.mise/tasks/audit/cargo`; target/platform applicability; and paths to `.audit/cargo-audit.json` and `.audit/cargo-audit.stderr`. Do not claim a pass from a prose summary alone.
- [ ] Finish with full status plus focused unstaged/staged diffs and EOL evidence for `cache.rs`. Confirm that only the planned frontend files and a conditional newline-only Rust file change belong to this work.

**Validation:**

- Run: `bun test`
- Expected: all discovered Bun tests pass with no unhandled rejection or timeout.
- Run: `mise run test-frontend`
- Expected: all isolated frontend `src/**/*.test.ts` tests pass.
- Run: `mise run typecheck`
- Expected: TypeScript reports no errors.
- Run: `mise run build`
- Expected: type checking and Vite production build succeed; build output contains no unexpected warning.
- Run: `mise run test`
- Expected: `cargo test --manifest-path src-tauri/Cargo.toml` passes all non-ignored Rust tests.
- Run: `mise run lint`
- Expected: ESLint and oxlint report no errors.
- Run: `mise run format:check`
- Expected: oxfmt and cargo fmt report no formatting changes.
- Run: `mise run audit:cargo`
- Expected: cargo-audit exits `0`; otherwise the advisory evidence contract above blocks completion.
- Run: `git status --short`
- Expected: every changed path is understood; no generated, staged, or unrelated change is attributed to the implementation.
- Run: `git diff -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: empty, unless Task 2 made a verified newline-only normalization.
- Run: `git diff --cached -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: empty.
- Run: `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: `i/lf w/lf`.

## Failure Behavior

- Unknown languages still return `null` and never load a grammar.
- A duplicate pending request reuses the registered promise and callback set. It does not start duplicate Shiki work.
- A rejected request enters the existing bounded failure cache, drops its callbacks, logs the existing structured error, and releases only its own pending slot.
- A rejected highlighter promise is removed only if it still owns the matching highlighter-cache entry.
- A fulfilled request enters the bounded success cache before callbacks run and releases only its own pending slot in `finally`.
- A genuinely unresolved Shiki promise remains represented as pending. The implementation must not evict it and pretend that work was cancelled.
- The Rust cache remains an untrusted optimization. Callers must continue to verify package and artifact digests.
- Any audit failure or staged semantic `cache.rs` change blocks completion; it is not normalized, waived, or hidden.

## Privacy and Security

- Cache keys contain language names, theme names, and source code within in-memory maps only. Do not add logging for source code, theme objects, tokens, or callback contents.
- Keep the existing error log free of code content. Log only the language and error object as it does now.
- Preserve deterministic SHA-256 Rust cache identity over all security-relevant inputs. Do not weaken digest verification or trust serialized components because of a cache hit.
- Audit artifacts can expose dependency names, versions, and local dependency paths. Keep them under the existing `.audit/` workflow; do not publish them externally without approval.

## Rollout Notes

- No migration, feature flag, configuration change, package addition, or deployment step is required.
- Do not stage, commit, or update dependencies as part of this plan unless separately requested or approved after concrete audit evidence.

## Risks and Mitigations

- **Custom theme object loss:** Using only theme names makes Shiki unable to initialize inline custom themes. Retain the original `ThemeInput` and test through rendered token styles.
- **Old promise deletes a newer request:** Compare exact promise identity in `finally` before deletion and prune only that structural bucket.
- **Apparent bound versus true pending work:** Do not add a fixed cap without a defined overload policy. Keep registry lifetime equal to promise lifetime and state this invariant in code.
- **Regression in coalescing or failure caching:** Keep and run the existing public plugin tests for duplicate requests, failed callbacks, retry after failure eviction, and success eviction.
- **Broad Rust formatting churn:** Inspect staged/unstaged state first and format only `cache.rs` when the mismatch is proven newline-only.
- **Hidden audit waiver:** Require the pinned audit task’s exit status plus JSON and inverse dependency evidence for every failure.

**Open Questions:** None.
