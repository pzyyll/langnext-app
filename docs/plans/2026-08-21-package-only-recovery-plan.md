# Implementation Plan

**Goal:** Finish and verify the recovered package-only migration fixes without hiding build warnings or Rust advisories, changing cache behavior back to legacy behavior, or retaining line-ending-only churn.

**Inputs:** Recovered-context report from Mr. Julian; current source, test, task, audit, and manifest files in the `package-only-migration` worktree; Vite 8 documentation from `/vitejs/vite/v8.0.10`.

**Assumptions:**

- The current worktree contains partial changes that must remain unless a focused test proves them incorrect.
- `mise run test-frontend` is the authoritative frontend suite. It runs `bun test --isolate src` through `.mise/tasks/test-frontend`.
- A nonzero `mise run audit:cargo` result is expected while actionable or unpatched advisories remain. Success means that the task preserves this nonzero status and prints useful details.
- Advisory remediation and transitive dependency upgrades are outside this recovery plan. This plan improves visibility only. A separate security plan must own dependency upgrades.
- The existing 500 kB Vite threshold remains authoritative. Vite documents `build.chunkSizeWarningLimit` as an uncompressed JavaScript threshold with a 500 kB default.
- No production behavior change is required in `src-tauri/src/services/wasm_runtime/cache.rs`. Only verified logic changes and LF line endings may remain.

**Architecture:** Keep the existing route-to-`LazyMarkdownOutput` dynamic boundary. Preserve the full-source Markdown cache identity, separate bounded success and failure caches, bounded highlighter promises, and in-flight deduplication. Treat frontend tests, Vite build logs, bundle manifest inspection, cargo-audit JSON, reverse dependency trees, and Git whitespace-aware diffs as independent validation seams.

**Tech Stack:** React 19, Bun test, Streamdown, Shiki 3.23, Vite 8/Rolldown, Bash mise tasks, cargo-audit 0.22.2, Rust 1.96.1, Wasmtime component cache code.

---

## Scope

### In scope

- Confirm staged and unstaged boundaries before any edit.
- Preserve or minimally correct the collision-safe bounded Markdown caches.
- Restore visible loading output across the lazy Markdown boundary.
- Make all in-scope frontend tests pass and require the complete frontend suite to be green.
- Detect Vite and Rolldown warnings, including standard `(!)` and ANSI-colored forms.
- Remove warning suppression from `vite.config.ts` and fix the warning source instead.
- Rebuild and inspect current Markdown/Shiki chunks and enforce the 500 kB limit.
- Print detailed cargo vulnerability and informational advisory output while preserving cargo-audit's nonzero status.
- Remove line-ending-only churn from `cache.rs` without rewriting its cache implementation.

### Out of scope

- Ignoring or allowlisting RustSec advisories.
- Raising `build.chunkSizeWarningLimit` to hide oversized assets.
- Restoring eager Markdown imports, truncated cache keys, unbounded caches, or empty Suspense fallbacks.
- Upgrading transitive Rust dependencies without a separate dependency-impact plan.
- Fixing unrelated frontend failures. Such failures block final acceptance and require a separately approved scope.
- Editing generated `src/routeTree.gen.ts` by hand.

## File Map

- Modify: `src/components/markdown/-codeHighlighter.ts` — only if focused tests expose a defect in full-source request identity, cache bounds, LRU behavior, or in-flight deduplication.
- Modify: `src/components/markdown/-codeHighlighter.test.ts` — retain and, only when a missing public behavior is found, extend cache contract coverage.
- Modify: `src/components/markdown/LazyMarkdownOutput.tsx` — only if the public fallback test fails; keep `TextLoading` as the non-empty fallback.
- Create: `src/components/markdown/-LazyMarkdownOutput.test.tsx` — verify visible lazy-boundary loading behavior through rendered DOM.
- Modify: `src/routes/translate/index.tsx` — only if route-level failure evidence shows an incorrect lazy Markdown or loading-state call site.
- Modify: `src/routes/quick-translate.tsx` — only if route-level failure evidence shows an incorrect lazy Markdown, waiting, or streaming-state call site.
- Modify: `scripts/frontend-bundle-diagnostics.ts` — classify ANSI-colored Vite/Rolldown diagnostics while preserving original diagnostic text.
- Modify: `scripts/frontend-bundle-diagnostics.test.ts` — cover plain and ANSI-colored `(!)` warnings, Rolldown warning blocks, clean summaries, and CLI exit status.
- Modify: `.mise/tasks/check/frontend-bundle` — keep the build warning gate, remove hash-specific asset matching, and retain manifest-based dynamic-boundary and 500 kB checks.
- Modify: `vite.config.ts` — remove `build.rolldownOptions.checks.pluginTimings: false`; do not replace it with another warning suppression setting.
- Modify: `scripts/cargo-audit-report.ts` — format vulnerabilities and informational warning categories and list unique affected `package@version` specs.
- Modify: `scripts/cargo-audit-report.test.ts` — cover vulnerabilities, `unmaintained`, `unsound`, patched, unpatched, deduplication, and malformed JSON.
- Modify: `.mise/tasks/audit/cargo` — print cargo-audit stderr when present, print all report sections, print reverse dependency paths for all reported package versions, and return the original audit status.
- Generated at validation time: `.audit/cargo-audit.json` — current machine-readable cargo-audit result; do not hand-edit.
- Generated at validation time: `.audit/cargo-audit.stderr` — raw cargo-audit stderr; do not hand-edit.
- Modify only for line endings or proven logic: `src-tauri/src/services/wasm_runtime/cache.rs` — retain component identity, bounded LRU, clear, lookup, insert, and tests with an LF-only minimal diff.
- Generated at validation time: `dist/.vite/manifest.json` and `dist/assets/**` — fresh bundle evidence; do not hand-edit.

## Seams

The requirement owner must confirm these seams before implementation starts.

- **Seam:** `createMarkdownCodeHighlighter()` and its returned `CodeHighlighterPlugin` — distinct source strings never share tokens; success, failure, and highlighter caches remain bounded; recent entries survive LRU pressure; equal in-flight requests share work.
- **Seam:** Rendered `LazyMarkdownOutput` DOM — a user sees retained text or a loading label while the Markdown module loads, then sees rendered Markdown after resolution.
- **Seam:** `findBuildDiagnostics(output)` and `bun scripts/frontend-bundle-diagnostics.ts <log>` — warning blocks are found in plain and ANSI-colored Vite/Rolldown logs; clean build summaries remain clean; warning logs exit nonzero.
- **Seam:** `mise run check:frontend-bundle` — a fresh production build fails on warnings, static Markdown inclusion, forbidden grammars/themes, or Markdown/Shiki assets over 500 kB.
- **Seam:** `formatAuditReport()`, advisory package-spec listing, and `mise run audit:cargo` — every cargo vulnerability and informational warning is visible, reverse dependency paths are attempted, and the original audit exit status is preserved.
- **Seam:** `component_cache_identity()` and `CompiledComponentCache` public methods — security-relevant inputs isolate identities and bounded LRU behavior remains correct after line-ending cleanup.
- **Seam:** `mise run test-frontend` — the complete frontend behavioral suite has zero failures.

## Execution Prerequisites

Use one shell session from the repository root. Do not edit before this capture.

```bash
baseline_dir="$(mktemp -d)"
git status --short | tee "$baseline_dir/git-status-short.txt"
git diff --stat | tee "$baseline_dir/git-diff-stat.txt"
git diff --binary > "$baseline_dir/git-unstaged.patch"
git diff --cached --binary > "$baseline_dir/git-staged.patch"
git diff --name-only | tee "$baseline_dir/git-unstaged-files.txt"
git diff --cached --name-only | tee "$baseline_dir/git-staged-files.txt"
```

Expected:

- The files in the staged and unstaged lists are explicit.
- The patch files preserve the original boundary for recovery if a later edit is wrong.
- No `git add`, `git restore`, formatter, build, or test command has run yet.

Then capture command baselines without stopping after the first nonzero result:

```bash
set +e
mise run test-frontend 2>&1 | tee "$baseline_dir/test-frontend.txt"
test_frontend_status=${PIPESTATUS[0]}
mise run build 2>&1 | tee "$baseline_dir/build.txt"
build_status=${PIPESTATUS[0]}
mise run check:frontend-bundle 2>&1 | tee "$baseline_dir/check-frontend-bundle.txt"
bundle_status=${PIPESTATUS[0]}
mise run audit:cargo 2>&1 | tee "$baseline_dir/audit-cargo.txt"
audit_status=${PIPESTATUS[0]}
set -e
printf 'test-frontend=%s\nbuild=%s\ncheck:frontend-bundle=%s\naudit:cargo=%s\n' \
  "$test_frontend_status" "$build_status" "$bundle_status" "$audit_status" \
  | tee "$baseline_dir/statuses.txt"
```

Expected:

- The frontend log contains each failed test name and its first assertion or setup error.
- The build and bundle logs establish whether current `dist/` is fresh.
- The cargo log and status prove whether detailed output is usable while the audit remains nonzero.
- The implementation notes retain `baseline_dir` until final validation finishes.

Classify every frontend failure before editing:

1. Lazy Markdown/loading boundary.
2. Markdown cache identity, LRU, failure handling, or in-flight behavior.
3. Build diagnostic parser or bundle gate.
4. Cargo report helper tests.
5. Unrelated existing failure.

Only categories 1–4 authorize edits in this plan. Category 5 blocks the final green-suite requirement and must be reported for separate scope.

## Tasks

### Task 1: Lock the Markdown cache contract

**Seam:** `createMarkdownCodeHighlighter()` and its returned `CodeHighlighterPlugin`.

**Outcome:** Full source text remains part of request identity. Equal-length inputs with equal prefixes and suffixes but different middle content receive distinct token results. Success and failure entries have independent 128-entry limits. Highlighter promises have a 16-entry limit. LRU touches and in-flight callback deduplication remain correct.

**Files:**

- Modify if required: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] Review the current tests by behavior. Keep the collision test, success LRU test, failure LRU test, success/failure isolation test, identical in-flight request test, stale callback test, and highlighter-promise LRU test.
- [ ] Do not expose internal maps or cache counters for tests. Observe behavior only through `CodeHighlighterPlugin.highlight`, loader calls, callbacks, and returned token objects.
- [ ] **Red:** If the baseline reports a cache failure, run only the named failing test before editing:

  ```bash
  bun test --isolate src/components/markdown/-codeHighlighter.test.ts --test-name-pattern '<exact failing test name>'
  ```

- [ ] Confirm that the failure distinguishes the required behavior. Do not change a passing test only to manufacture red.
- [ ] **Green:** Make the smallest correction in `-codeHighlighter.ts`. Keep complete `highlight.code` strings as bucket keys. Keep `MAX_TOKEN_CACHE_ENTRIES`, `MAX_FAILED_CACHE_ENTRIES`, and `MAX_HIGHLIGHTER_CACHE_ENTRIES` as named constants. Do not combine success and failure limits.
- [ ] Preserve removal of rejected highlighter promises, callback cleanup after failure, and load deduplication for equal language/theme/source requests.
- [ ] Run the complete focused file after each correction.

**Validation:**

- Run (red, only when baseline failed): the exact `--test-name-pattern` command above.
- Expected: the named assertion fails for collision, eviction, retry, or deduplication behavior.
- Run (green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected: all highlighter contract tests pass with no timeout and no unexpected grammar load.

### Task 2: Verify the visible lazy Markdown fallback

**Seam:** Rendered `LazyMarkdownOutput` DOM.

**Outcome:** A Markdown output never becomes blank only because the renderer chunk is loading. Waiting output shows the loading label and dots. Retained output shows retained text and the loading indicator. Active streaming output passes `scramble` behavior to `TextLoading`. The resolved component still renders Markdown.

**Files:**

- Create: `src/components/markdown/-LazyMarkdownOutput.test.tsx`
- Modify if required: `src/components/markdown/LazyMarkdownOutput.tsx`
- Modify only with route-specific failure evidence: `src/routes/translate/index.tsx`
- Modify only with route-specific failure evidence: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] **Red:** Add an isolated React Testing Library test that renders `LazyMarkdownOutput` before its dynamic import settles and asserts the public DOM state. Cover these vertical scenarios one at a time:
  1. Empty text plus `isLoading=true` shows the normalized loading label with `role="status"` and `aria-busy="true"`.
  2. Retained text plus `isLoading=true` keeps that text visible while the boundary resolves.
  3. After resolution, Markdown content appears and the fallback leaves the DOM.
- [ ] Start with scenario 1. Run it before any production edit. If the recovered implementation already passes, record it as preserved behavior and do not regress it. Add scenarios 2 and 3 one at a time.
- [ ] Test the exported component. Do not inspect React internals or mock `Suspense`.
- [ ] **Green:** If a scenario fails, make the smallest change to the fallback props. Keep `TextLoading`; do not use `null`, an empty fragment, or eager `MarkdownOutput` import.
- [ ] Confirm both routes pass `text`, actual loading state, actual streaming state, and translated loading label to `LazyMarkdownOutput`.
- [ ] Keep quick-translate's pre-request waiting state on `TextLoading`. Do not replace it with legacy placeholder behavior.

**Validation:**

- Run (red/green per scenario): `bun test --isolate src/components/markdown/-LazyMarkdownOutput.test.tsx`
- Expected red: a missing or incorrect fallback does not expose the loading label, retained text, status semantics, or resolved Markdown.
- Expected green: all three public DOM scenarios pass.
- Run: `bun test --isolate src/components/markdown/-LazyMarkdownOutput.test.tsx src/components/markdown/-codeHighlighter.test.ts`
- Expected: fallback and cache contracts pass together.

### Task 3: Harden warning detection without suppression

**Seam:** `findBuildDiagnostics(output)` and the diagnostics CLI.

**Outcome:** Plain and ANSI-colored Vite `(!)` blocks, Rolldown warnings, bracket warnings, and unresolved warnings cause a nonzero CLI result. Normal progress and application prose do not cause false positives. No Vite/Rolldown warning category is disabled in configuration.

**Files:**

- Modify: `scripts/frontend-bundle-diagnostics.test.ts`
- Modify: `scripts/frontend-bundle-diagnostics.ts`
- Modify: `vite.config.ts`

**Steps:**

- [ ] **Red:** Add a fixture with ANSI color sequences around the Vite `(!)` prefix and message. Assert that `findBuildDiagnostics` returns one block with the original text unchanged.
- [ ] Run the focused parser test and confirm the current regex misses the colored prefix.
- [ ] **Green:** Add one named ANSI escape pattern and classify each line through a stripped copy. Keep the original line in the captured block so stderr remains faithful to the build output.
- [ ] Keep the existing plain `/^\s*\(!\)\s+\S/` behavior, Rolldown warning detection, unresolved warning detection, clean-summary test, and CLI exit tests.
- [ ] Add a CLI test for the ANSI-colored warning log. Expect exit 1 and the original warning text on stderr.
- [ ] Remove only the `build.rolldownOptions.checks.pluginTimings: false` block from `vite.config.ts`. Do not add `logLevel: "silent"`, `chunkSizeWarningLimit` inflation, warning filters, or equivalent suppression.
- [ ] Run a real build. If it emits `PLUGIN_TIMINGS` or another warning, keep the gate red and correct the source configuration or plugin usage in the owning file. Do not disable the check. Record any required new file in the implementation notes before editing it.

**Validation:**

- Run (red): `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts --test-name-pattern 'ANSI'`
- Expected: the new ANSI warning assertion fails before parser normalization.
- Run (green): `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts`
- Expected: all parser and CLI tests pass; warning cases exit 1 and clean cases exit 0.
- Run: `mise run build 2>&1 | tee "$baseline_dir/build-after-warning-fix.txt"`
- Expected: exit 0 and no warning diagnostic. Any `(!)`, `WARN`, `[WARNING]`, `UNRESOLVED_WARNING`, or `UNRESOLVED_IMPORT` output keeps this task incomplete.

### Task 4: Verify the fresh Markdown/Shiki bundle boundary

**Seam:** `mise run check:frontend-bundle`.

**Outcome:** The task builds current source, rejects any warning, proves both translation routes reach `MarkdownOutput.tsx` only through a dynamic import, rejects forbidden language/theme content, and rejects each Markdown/Shiki-related asset over 500 kB.

**Files:**

- Modify only if required: `.mise/tasks/check/frontend-bundle`
- Generated: `dist/.vite/manifest.json`
- Generated: `dist/assets/**`

**Steps:**

- [ ] Remove the hash-specific `chunk-BO2N2NFS` alternative from `relatedNamePattern`. Build hashes are not stable interfaces.
- [ ] Keep allowed language IDs, allowed theme IDs, forbidden package tokens, route module paths, Markdown module path, and `MAX_MARKDOWN_RELATED_ASSET_BYTES` as named values.
- [ ] **Red:** Before changing the task, create a temporary copy of one fresh Markdown-related asset larger than 500 kB under `dist/assets/` and run only the inspector phase through the task's existing Bun inspector logic. Confirm the gate names the oversized asset and exits 1. Remove the temporary asset immediately. Do not commit it.
- [ ] **Green:** Make the smallest matching correction needed after removing the hash-specific token. Identify related assets by stable allowed names, manifest module identity, or Shiki content. Do not rely on generated hashes.
- [ ] Run the complete task. It must rebuild before reading the manifest.
- [ ] Read the fresh `dist/.vite/manifest.json`. Confirm `MarkdownOutput.tsx` exists, neither route's static closure contains it, and each route's dynamic imports reach it.
- [ ] Read emitted asset sizes. Confirm no related asset exceeds `500 * 1024` bytes.

**Validation:**

- Run (red): the temporary oversized-asset check described above.
- Expected: nonzero exit with `is a Markdown/Shiki asset larger than 512000 bytes`.
- Run (green): `mise run check:frontend-bundle`
- Expected: exit 0; no warning diagnostics; allowlisted grammars/themes only; both routes dynamically import Markdown; no related asset exceeds 500 kB.
- Run: `git status --short dist`
- Expected: only expected ignored or generated bundle output appears. Do not stage `dist/` unless repository policy already tracks it.

### Task 5: Report every cargo advisory and preserve failure status

**Seam:** `formatAuditReport()`, advisory package-spec listing, and `mise run audit:cargo`.

**Outcome:** Nonzero cargo-audit output includes vulnerability rows and informational warning rows, including advisory ID, category, package/version, title, patched requirements or `UNPATCHED`, and URL. Reverse dependency trees run once per unique package/version. The task returns cargo-audit's original nonzero status even if report formatting or a tree lookup also fails.

**Files:**

- Modify: `scripts/cargo-audit-report.test.ts`
- Modify: `scripts/cargo-audit-report.ts`
- Modify: `.mise/tasks/audit/cargo`
- Generated: `.audit/cargo-audit.json`
- Generated: `.audit/cargo-audit.stderr`

**Steps:**

- [ ] **Red:** Extend the fixture with one `warnings.unsound` entry for `event-listener 5.4.1` and one `warnings.unmaintained` entry. Assert the formatted report includes category, advisory ID, package/version, title, patched or `UNPATCHED`, and URL.
- [ ] Add a package-spec test that deduplicates repeated vulnerability and warning entries for the same package/version while preserving first-seen order.
- [ ] Add malformed-warning tests for missing advisory or package fields.
- [ ] Run the focused report tests and confirm the current vulnerability-only parser fails the new warning assertions.
- [ ] **Green:** Extend `CargoAuditReport` with typed access to cargo-audit warning category arrays. Flatten vulnerabilities and warning categories through one validated row reader. Add a `Category` column or explicit section labels. Do not print advisory descriptions.
- [ ] Replace `listVulnerablePackageSpecs` with a name that covers all advisory rows, or keep a compatibility wrapper and add `listAdvisoryPackageSpecs`. Update `.mise/tasks/audit/cargo` to use the all-advisory API.
- [ ] In `.mise/tasks/audit/cargo`, print `.audit/cargo-audit.stderr` to stderr when it is non-empty. Then print the formatted report and reverse dependency paths.
- [ ] Keep `set +e` around reporter and `cargo tree` diagnostics. Capture their statuses for messages, but finish with `exit "$audit_status"`.
- [ ] Do not pass cargo-audit ignore flags. Do not filter out `unmaintained`, `unsound`, or `notice` categories.

**Validation:**

- Run (red): `bun test --isolate scripts/cargo-audit-report.test.ts --test-name-pattern 'warning|advisory'`
- Expected: warning rows or all-advisory package specs are missing before implementation.
- Run (green): `bun test --isolate scripts/cargo-audit-report.test.ts`
- Expected: all vulnerability, warning, deduplication, redaction, and malformed-input tests pass.
- Run:

  ```bash
  set +e
  mise run audit:cargo 2>&1 | tee "$baseline_dir/audit-cargo-after.txt"
  audit_status=${PIPESTATUS[0]}
  set -e
  test "$audit_status" -ne 0
  ```

- Expected: the command remains nonzero while advisories exist. Output includes all five current vulnerability entries, `event-listener 5.4.1` unsound output, GTK3/unmaintained output, `UNPATCHED` for `rsa 0.9.10`, `Full report: .audit/cargo-audit.json`, and a reverse dependency-path heading for each unique reported package/version. Tree lookup failures are visible but do not replace the original audit status.

### Task 6: Remove `cache.rs` line-ending churn safely

**Seam:** `component_cache_identity()` and `CompiledComponentCache` public methods; Git staged and unstaged diffs for `cache.rs`.

**Outcome:** The Rust cache behavior remains unchanged. Real logic edits remain in their original staged or unstaged layer. Line-ending-only changes disappear. The final file uses LF and has a minimal diff.

**Files:**

- Modify only as reconstructed: `src-tauri/src/services/wasm_runtime/cache.rs`

**Steps:**

- [ ] Capture both layers separately before touching the file:

  ```bash
  cache_path='src-tauri/src/services/wasm_runtime/cache.rs'
  git diff --cached --binary -- "$cache_path" > "$baseline_dir/cache-staged.patch"
  git diff --binary -- "$cache_path" > "$baseline_dir/cache-unstaged.patch"
  git diff --cached --ignore-space-at-eol -- "$cache_path" > "$baseline_dir/cache-staged-logical.patch"
  git diff --ignore-space-at-eol -- "$cache_path" > "$baseline_dir/cache-unstaged-logical.patch"
  git diff --numstat -- "$cache_path" | tee "$baseline_dir/cache-numstat-before.txt"
  ```

- [ ] Inspect the two logical patches. Preserve only changes to identity inputs, bounded LRU, clear, lookup, insert, or their tests. If both logical patches are empty, the file has no real edit and should match the correct index/HEAD content exactly.
- [ ] Create a disposable detached worktree at `HEAD`. Apply the staged logical patch with `git apply --index`, then the unstaged logical patch with `git apply`. Run rustfmt there. This validates reconstruction before current-worktree replacement.
- [ ] Back up the current file. Reconstruct the current staged and unstaged layers from the validated logical patches. Do not use a whole-file editor rewrite.
- [ ] Verify all bytes use LF with a Bun one-liner that fails if `\r` exists. Do not add a repository-wide EOL policy in this scoped task.
- [ ] **Behavior check:** Run the focused Rust cache tests after reconstruction. No new behavior test is required because this task removes non-semantic churn; existing public cache tests are the regression seam.

**Validation:**

- Run:

  ```bash
  git diff --cached --ignore-space-at-eol -- "$cache_path"
  git diff --ignore-space-at-eol -- "$cache_path"
  git diff --numstat -- "$cache_path"
  bun -e 'const p="src-tauri/src/services/wasm_runtime/cache.rs"; const b=await Bun.file(p).arrayBuffer(); if (new Uint8Array(b).includes(13)) process.exit(1)'
  cargo test --manifest-path src-tauri/Cargo.toml services::wasm_runtime::cache::tests
  cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
  ```

- Expected: whitespace-aware diffs show only intended logic edits; numstat no longer represents a whole-file replacement; the CR-byte check exits 0; all cache tests pass; rustfmt check passes.
- [ ] Compare final staged and unstaged logical patches to the captured logical patches. Any lost real hunk or moved boundary keeps this task incomplete.

### Task 7: Drive the complete frontend suite to green

**Seam:** `mise run test-frontend`.

**Outcome:** All frontend tests pass. Every original failure has a recorded category and resolution. No unrelated behavior is silently changed.

**Files:**

- Modify only the in-scope files identified in Tasks 1–5.
- Test only the corresponding adjacent test file for each in-scope failure.

**Steps:**

- [ ] Run `mise run test-frontend` after each vertical slice, not only at the end.
- [ ] For each remaining failure, record the test name, first assertion/setup error, classification, owning file, and focused command.
- [ ] **Red:** Re-run one remaining in-scope failed test by exact name and confirm it fails independently.
- [ ] **Green:** Make one minimal owning-file change and rerun that exact test until it passes.
- [ ] Run the owning test file, then the complete frontend suite before moving to the next failure.
- [ ] If a failure is unrelated to lazy Markdown, cache behavior, bundle diagnostics, or cargo report helpers, stop. Report it as a blocker and request separate scope. Do not weaken, skip, rename, or delete the test.
- [ ] Do not use `.only`, `.skip`, reduced discovery paths, increased timeouts without evidence, or environment-specific bypasses to claim green.

**Validation:**

- Run (red): `bun test --isolate <owning-test-file> --test-name-pattern '<exact failing test name>'`
- Expected: the single in-scope failure reproduces.
- Run (green): the same focused command.
- Expected: the test passes after one minimal behavior correction.
- Run: `mise run test-frontend`
- Expected: exit 0 and zero failed tests. This requirement is not met if any unrelated failure remains; report the blocker instead of completing the plan.

## Final Validation

Run in this order from the repository root:

```bash
mise run test-frontend
mise run typecheck
mise run lint
mise run format:check
mise run build
mise run check:frontend-bundle

set +e
mise run audit:cargo 2>&1 | tee "$baseline_dir/audit-cargo-final.txt"
final_audit_status=${PIPESTATUS[0]}
set -e
test "$final_audit_status" -ne 0

git status --short
git diff --stat
git diff
git diff --cached
git diff --check
git diff --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs
git diff --numstat -- src-tauri/src/services/wasm_runtime/cache.rs
```

Expected:

- Frontend tests, typecheck, lint, format check, build, and frontend bundle check exit 0.
- Build logs contain no Vite/Rolldown warnings.
- Fresh manifest evidence proves dynamic Markdown loading from both routes.
- No Markdown/Shiki-related asset exceeds 500 kB uncompressed.
- Cargo audit remains nonzero while current advisories exist, but prints detailed vulnerability and warning rows plus dependency-path attempts.
- `git diff --check` exits 0.
- `cache.rs` shows only intended logical edits and no whole-file line-ending churn.
- Staged and unstaged file lists still match the intended ownership captured at baseline, except for explicitly documented task edits.

## Failure Behavior

- **Unknown frontend failures:** Keep the suite red and report exact blockers. Do not expand scope or weaken tests.
- **Markdown grammar load failure:** Return `null`, drop stale callbacks, cache the failure within its independent bound, log the error, and permit retry only after LRU eviction.
- **Unknown Markdown language:** Return unhighlighted output and do not load a grammar.
- **Lazy module delay:** Keep user-visible text or loading copy in the DOM until Markdown resolves.
- **Build warning:** Fail `check:frontend-bundle` after printing the complete warning block.
- **Build failure plus warning:** Report both; return the original build status when the build itself failed.
- **Malformed cargo JSON:** Print a precise reporter error, print cargo-audit stderr if available, and preserve cargo-audit's original status.
- **`cargo tree` failure:** Print the package/version and tree failure status; continue other package paths; preserve the audit status.
- **Line-ending reconstruction mismatch:** Restore from the captured staged and unstaged patches. Do not continue with a partial cache diff.

## Privacy and Security

- Full Markdown source is held only in bounded in-memory cache keys. Do not log source text or serialize these caches.
- Cargo report output may include package names, versions, advisory metadata, and dependency paths. It must not print advisory descriptions or secrets from environment/config files.
- Cached Wasmtime artifacts remain untrusted optimizations. Callers must continue digest verification. Keep package digest, artifact digest, host API version, Wasmtime version, config revision, and target triple in the identity.
- Do not ignore RustSec findings. `rsa 0.9.10` remains visibly unpatched. Patched advisories must show their upgrade requirement.

## Rollout Notes

- No data migration or feature flag is required.
- Do not stage or commit as part of implementation unless Mr. Julian requests it.
- Keep generated `dist/` and `.audit/` handling consistent with existing repository tracking rules.
- Create a separate dependency-remediation plan after reverse dependency paths identify the direct owners of `quick-xml`, `rsa`, `event-listener`, and GTK3 advisory chains.

## Risks and Mitigations

- **Recovered tests and implementation may already be green, so a natural red state is unavailable.** Do not regress code to manufacture red. Treat passing recovered contract tests as preservation evidence. Require red-before-green for each newly discovered defect or newly added missing behavior.
- **ANSI handling can alter printed diagnostics.** Classify through stripped copies but retain raw lines for output.
- **Generated chunk hashes change between builds.** Remove hash-specific matching and use stable module/content evidence.
- **Cargo informational warning schemas can vary by category.** Validate each category array and fail clearly on malformed rows.
- **Audit output can be very large.** Keep table rows concise and omit descriptions; keep full JSON in `.audit/cargo-audit.json`.
- **EOL cleanup can erase staged/unstaged ownership.** Capture both layers, validate reconstruction in a disposable worktree, and compare final logical patches before completion.
- **The reported 36 failures may be unrelated.** Require classification and separate approval rather than hiding or opportunistically fixing them.

## Open Questions

- The exact staged/unstaged boundary remains unknown until the execution prerequisite commands run.
- The exact frontend failure list remains unknown until `mise run test-frontend` runs. Any unrelated failure is a blocker to the requested all-green result.
- The source of any warning exposed after removal of `pluginTimings: false` remains unknown until the fresh build runs. The implementation must fix the source, not suppress the diagnostic.
- The direct dependency owners of current RustSec entries remain unknown until `cargo tree -i package@version` succeeds. Dependency remediation is intentionally separate.
