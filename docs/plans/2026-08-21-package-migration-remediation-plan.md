# Implementation Plan

**Goal:** Make the package-only migration correct and diagnosable by fixing Markdown highlighting and loading behavior, enforcing zero-warning frontend builds, reporting and remediating Rust advisories without suppression, and removing non-semantic `cache.rs` whitespace churn.

**Inputs:** The supplied read-only inspection report; the current repository files listed below; React 19.2.7 Suspense behavior from Context7 `/react/react/v19.2.7`; Vite 8 Rolldown and chunk warning behavior from Context7 `/vitejs/vite/v8.0.10`; the supplied quick-xml 0.41.0 and RustSec advisory sources.

**Assumptions:**

- The reported 36 frontend failures are the pre-change baseline. The implementer must confirm the exact test names and causes before changing code.
- The requested seams and scenarios are user-confirmed by this task. No additional seam confirmation is required before tests are written.
- The two `quick-xml` versions and `rsa 0.9.10` are transitive until `cargo tree -i` proves otherwise.
- `RUSTSEC-2023-0071` remains unpatched during implementation. The audit gate must remain nonzero while that advisory is present.
- No task stages or commits files. Existing staged state, if any, is read-only evidence.

**Architecture:** Keep Markdown rendering lazy, but move a visible `TextLoading` fallback into the shared lazy boundary so both translation routes preserve status content while React suspends. Replace lossy concatenated highlighter keys with language/theme buckets keyed by the exact code string, and apply independent LRU limits to success, failure, and highlighter-promise caches. Move build-log and cargo-audit reporting logic into small tested scripts, while the existing `mise` tasks retain process orchestration and original exit statuses.

**Tech Stack:** React 19, Bun test, Streamdown, Shiki 3.23, TypeScript, Vite 8 with Rolldown, Bash `mise` tasks, Rust/Cargo, cargo-audit 0.22.2, oxfmt, rustfmt.

---

## Evidence Gate

Run these commands before Task 1. Save their console output outside the repository or in the implementation session log. Do not create another document.

1. Run `bun test --isolate src`.
   - Expected before implementation: 36 failures, as reported.
   - Record every failing test name, test file, first actionable error, and whether it belongs to the known highlighter/loading work or another behavior regression.
   - If the count is not 36, use the observed count as the baseline and report the mismatch. Do not discard failures to match the supplied number.
2. Run `git diff --cached -- src/components/markdown/-codeHighlighter.ts src/components/markdown/-codeHighlighter.test.ts src/components/markdown/LazyMarkdownOutput.tsx src/components/markdown/LazyMarkdownOutput.test.tsx src/routes/translate/index.tsx src/routes/quick-translate.tsx .mise/tasks/check/frontend-bundle .mise/tasks/audit/cargo src-tauri/src/services/wasm_runtime/cache.rs`.
   - Expected: the exact staged implementation, if one exists, becomes available for comparison.
3. Run `git diff --numstat -- src-tauri/src/services/wasm_runtime/cache.rs`, `git diff --check -- src-tauri/src/services/wasm_runtime/cache.rs`, and `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`.
   - Expected: the actual working-tree churn, whitespace errors, and index/worktree EOL states are known.
4. Run:
   - `cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.30.0`
   - `cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.39.4`
   - `cargo tree --manifest-path src-tauri/Cargo.toml -i rsa@0.9.10`
   - Expected: each command prints every inverse dependency path to `langnext-app`.

Stop and report a blocker only if a command cannot run or a dependency graph is internally inconsistent. A changed failure count or dependency path is evidence, not a reason to stop.

## File Map

- Modify: `src/components/markdown/-codeHighlighter.ts` — exact request identity, bounded success/failure LRUs, bounded highlighter-promise LRU, and in-flight cleanup.
- Test: `src/components/markdown/-codeHighlighter.test.ts` — collision, capacity, eviction, retry, and in-flight callback contracts through `CodeHighlighterPlugin.highlight`.
- Modify: `src/components/markdown/LazyMarkdownOutput.tsx` — shared visible and accessible Suspense fallback based on `TextLoading`.
- Test: `src/components/markdown/LazyMarkdownOutput.test.tsx` — fallback status and deferred Markdown behavior.
- Modify: `src/routes/translate/index.tsx` — pass translation loading state and label to the shared Markdown boundary.
- Modify: `src/routes/quick-translate.tsx` — pass slot loading state and label to the same boundary.
- Create: `scripts/frontend-bundle-diagnostics.ts` — parse complete warning blocks and expose a CLI that reads a captured build log. Start with two `ABOUTME` lines.
- Test: `scripts/frontend-bundle-diagnostics.test.ts` — Vite/Rolldown warning and non-warning fixtures. Start with two `ABOUTME` lines.
- Modify: `.mise/tasks/check/frontend-bundle` — merge build output, preserve build status, invoke the parser, and fail on any diagnostic block.
- Create: `scripts/cargo-audit-report.ts` — parse cargo-audit JSON and print a concise vulnerability table. Start with two `ABOUTME` lines.
- Test: `scripts/cargo-audit-report.test.ts` — advisory fields, patched/unpatched labels, URLs, and malformed-report handling. Start with two `ABOUTME` lines.
- Modify: `.mise/tasks/audit/cargo` — capture JSON, print the summary and inverse dependency trees on failure, and return the original audit status.
- Modify if required by confirmed dependency paths: `src-tauri/Cargo.toml` — bump only the nearest direct dependency that constrains a vulnerable `quick-xml` version.
- Modify: `src-tauri/Cargo.lock` — resolve both vulnerable `quick-xml` versions to patched dependency graphs.
- Modify only for byte normalization: `src-tauri/src/services/wasm_runtime/cache.rs` — LF endings, no trailing whitespace, one final newline, and no semantic edit.
- Dynamic test/implementation paths from the Evidence Gate — only files named by the residual frontend failures. These paths cannot be known until `bun test --isolate src` runs; record them before editing and keep each fix scoped to its public seam.

## Seams

- **Seam:** `createMarkdownCodeHighlighter(...): CodeHighlighterPlugin`, observed through `supportsLanguage`, `getThemes`, and `highlight` — exact result identity, bounded retention, retry, and request coalescing.
- **Seam:** `<LazyMarkdownOutput />` DOM output — visible retained text, loading status semantics, and deferred Markdown replacement while `React.lazy` suspends.
- **Seam:** `findBuildDiagnostics(output)` and its CLI exit contract — warning-block classification without false positives.
- **Seam:** `mise run check:frontend-bundle` — one merged diagnostic stream, original build failure propagation, and zero-warning success.
- **Seam:** cargo-audit JSON to `scripts/cargo-audit-report.ts` output — actionable advisory fields and explicit patched/unpatched status.
- **Seam:** `mise run audit:cargo` — persisted JSON, inverse dependency paths, and unchanged nonzero audit status.
- **Seam:** `src-tauri/Cargo.lock` as observed by `cargo tree -i` and cargo-audit — patched quick-xml resolution without advisory suppression.
- **Seam:** Git's normalized view of `src-tauri/src/services/wasm_runtime/cache.rs` — byte-format-only change with no semantic diff.
- **Seam:** `bun test --isolate src` — all frontend behavior contracts; no weakened or skipped assertion.

## Tasks

### Task 1: Make highlight identity collision-safe

**Seam:** `CodeHighlighterPlugin.highlight`.

**Outcome:** Two requests with equal language, themes, length, prefix, and suffix but different middle content never share tokens or in-flight state.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add one test with two same-length JavaScript strings that share the first and last 100 characters but differ in the middle. Start both requests before either resolves. Assert both callbacks complete, each result contains its own distinct middle token, and each subsequent `highlight` call returns its matching cached result.
- [ ] Run the targeted test and confirm it fails because the second request reuses the first request's lossy key/result.
- [ ] **Green:** Delete `CACHE_KEY_PREFIX_LENGTH`, `CACHE_KEY_SUFFIX_LENGTH`, and `highlightCacheKey`. Introduce `ThemeKey`, exact-code cache buckets, and helper accessors keyed as `language -> theme pair -> exact code`.
- [ ] Use the same exact request identity for token entries, failure entries, callback sets, and in-flight loads. Do not create another lossy hash or concatenated code key.
- [ ] Keep language aliases and the public Streamdown plugin contract unchanged.

**Validation:**

- Run (red): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): the new collision test reports reused or incorrect tokens.
- Run (green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (green): the collision test and existing language/theme tests pass.

### Task 2: Bound successful token retention

**Seam:** `CodeHighlighterPlugin.highlight`.

**Outcome:** Successful entries use access-order LRU behavior and retain at most 128 exact requests.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add `MAX_TOKEN_CACHE_ENTRIES = 128` to the test vocabulary and add one behavioral test that fills 128 successful entries, touches the first entry, inserts a 129th entry, then proves the untouched least-recent entry returns `null` and reloads while the touched entry remains an immediate hit.
- [ ] **Green:** Add the production constant `MAX_TOKEN_CACHE_ENTRIES = 128`, a monotonic access generation, `touchCacheEntry`, `rememberSuccess`, `deleteCacheEntry`, and kind-specific least-recent eviction.
- [ ] Count success entries independently. A failure must not consume or evict the success capacity.
- [ ] On a successful cache lookup, update `lastAccess` before returning the result.

**Validation:**

- Run (red/green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): the 129th success leaves the old entry cached or grows without eviction.
- Expected (green): the least-recent success reloads and all other highlighter tests pass.

### Task 3: Bound failed requests and permit retry after eviction

**Seam:** `CodeHighlighterPlugin.highlight` with injected `languageLoaders`.

**Outcome:** Failed entries retain at most 128 exact requests; inserting another failure evicts the least-recent failure, and an evicted request can invoke its loader again.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add a loader that rejects and a polling helper bounded by `HIGHLIGHT_CALLBACK_TIMEOUT_MS`. Fail 129 distinct exact requests, retry the oldest request, and assert the loader is invoked again only after that request is evicted.
- [ ] **Green:** Add `MAX_FAILED_CACHE_ENTRIES = 128`; replace the permanent `Set` with `CacheEntry { kind: "failure", lastAccess }`; apply a failure-only LRU limit in `rememberFailure`.
- [ ] Remove a rejected highlighter promise from `highlighterByKey` if the map still holds that same promise. This prevents a rejected promise from permanently blocking retries.
- [ ] Keep failure behavior as `null` plus the existing redacted `console.error`; do not expose source code in the log.

**Validation:**

- Run (red/green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): the first failure is remembered forever or the rejected highlighter promise prevents another loader call.
- Expected (green): the evicted failure retries and the failure cache does not displace successful tokens.

### Task 4: Preserve successful in-flight fan-out

**Seam:** `CodeHighlighterPlugin.highlight` callbacks.

**Outcome:** Concurrent identical requests start one highlighter load and every distinct callback receives the same result object once.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add one controllable language loader. Call `highlight` three times for the same exact request before resolving it. Assert one loader invocation, three callback invocations, and strict result-object identity across callbacks.
- [ ] **Green:** Reuse one callback set and one in-flight marker in the exact request bucket. On success, remove both in-flight structures before invoking callbacks, then invoke each callback with the one cached token object.

**Validation:**

- Run (red/green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): collision-key or fan-out behavior violates at least one assertion.
- Expected (green): one load serves all callbacks exactly once.

### Task 5: Clean failed in-flight callbacks

**Seam:** `CodeHighlighterPlugin.highlight` callbacks.

**Outcome:** A failed request drops stale callbacks; after failure eviction, a successful retry calls only the new callback.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add a loader sequence that fails the first request, fills enough failures to evict it, then succeeds on retry. Assert the callback registered before failure is never called and the retry callback receives the result once.
- [ ] **Green:** On rejection, delete the exact request's callback set and in-flight marker before remembering the failure. Ensure `finally` is idempotent and does not delete state for a later retry.

**Validation:**

- Run (red/green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): stale callbacks survive or retry remains blocked.
- Expected (green): only the retry callback runs.

### Task 6: Bound highlighter promises

**Seam:** `CodeHighlighterPlugin.highlight` across language/theme pairs.

**Outcome:** Resolved highlighter promises use an LRU limit of 16, and rejected promises never remain cached.

**Files:**

- Modify: `src/components/markdown/-codeHighlighter.ts`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Add `MAX_HIGHLIGHTER_CACHE_ENTRIES = 16` to the test vocabulary. Exercise 17 valid canonical-language/ordered-GitHub-theme pairs, then submit uncached code for the least-recent pair and prove its language loader runs again. Touch one earlier pair before insertion to prove access-order, not insertion-order, eviction.
- [ ] **Green:** Store `{ promise, lastAccess }` per highlighter key, touch on reuse, and evict the least-recent entry before insertion when the map reaches 16.
- [ ] Never cancel an evicted in-flight promise. Its request callbacks must still complete. Remove a rejected promise only when identity matches the rejected map entry.

**Validation:**

- Run (red/green): `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
- Expected (red): all resolved highlighters remain cached.
- Expected (green): the least-recent pair is recreated; the complete file passes without timeout.

### Task 7: Restore the Markdown loading boundary

**Seam:** `<LazyMarkdownOutput />` DOM output.

**Outcome:** Suspended Markdown keeps visible output and accessible loading state instead of rendering an empty pane.

**Files:**

- Modify: `src/components/markdown/LazyMarkdownOutput.tsx`
- Test: `src/components/markdown/LazyMarkdownOutput.test.tsx`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] **Red:** Replace the existing empty-fallback assertion with a behavior test that renders non-empty text while loading. Before the lazy module resolves, assert the text is visible, the fallback has `role="status"` and `aria-busy="true"`, and a loading indicator is present. Then assert the Markdown renderer replaces the fallback after resolution.
- [ ] **Green:** Extend the boundary props with required `isLoading` and `loadingLabel` values. Render `TextLoading` as the Suspense fallback with `text`, `isLoading`, `scramble={isStreaming}`, `loadingLabel`, and the existing output text color.
- [ ] Pass `isTranslating` and `t("translate.translating")` from `src/routes/translate/index.tsx`.
- [ ] Pass `result.isTranslating` and the same translated label from `src/routes/quick-translate.tsx`.
- [ ] Keep each route's empty waiting state in its existing `TextLoading` branch. Do not move Suspense around the full output pane and do not use `fallback={null}`.

**Validation:**

- Run (red): `bun test --isolate src/components/markdown/LazyMarkdownOutput.test.tsx`
- Expected (red): the current boundary has empty `textContent` and no status node.
- Run (green): `bun test --isolate src/components/markdown/LazyMarkdownOutput.test.tsx`
- Expected (green): retained text/status is present during suspension and Markdown appears afterward.
- Run: `mise run typecheck`
- Expected: both routes supply the new required props.

### Task 8: Detect Vite oversized-chunk warning blocks

**Seam:** `findBuildDiagnostics(output)`.

**Outcome:** The parser returns the complete `(!) Some chunks are larger than 500 kB after minification.` block.

**Files:**

- Create: `scripts/frontend-bundle-diagnostics.ts`
- Create: `scripts/frontend-bundle-diagnostics.test.ts`

**Steps:**

- [ ] **Red:** Add one literal Vite fixture with the `(!)` headline and its recommendation lines. Assert one returned diagnostic string equals the complete block.
- [ ] **Green:** Implement `findBuildDiagnostics(output: string): string[]`. Split on `/\r?\n/`; start a block only on `^\s*\(!\)\s+`; retain following indented or bullet continuation lines until a blank line or a new top-level build/progress line.
- [ ] Add a CLI path argument that reads the captured log, prints all blocks unchanged to stderr, and exits 1 when any block exists, otherwise 0.

**Validation:**

- Run (red/green): `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts`
- Expected (red): no parser exists or the oversized warning is missed.
- Expected (green): the exact multiline block is returned.

### Task 9: Detect Rolldown and unresolved diagnostics

**Seam:** `findBuildDiagnostics(output)`.

**Outcome:** Anchored warning prefixes and unresolved diagnostics fail without matching arbitrary prose.

**Files:**

- Modify: `scripts/frontend-bundle-diagnostics.ts`
- Test: `scripts/frontend-bundle-diagnostics.test.ts`

**Steps:**

- [ ] **Red:** Add one fixture each for an anchored `WARN`/`WARNING` Rolldown block, `[WARNING]`, `UNRESOLVED_WARNING`, and `UNRESOLVED_IMPORT`. Assert each becomes one preserved block.
- [ ] **Green:** Add anchored, case-insensitive prefix rules for `WARN`, `WARNING`, and tool-qualified Vite/Rolldown/Rollup warning prefixes. Retain exact unresolved diagnostic tokens for compatibility.
- [ ] Do not use an unanchored `/warning/i` match by itself.

**Validation:**

- Run (red/green): `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts`
- Expected (red): at least Rolldown or unresolved fixtures are missed.
- Expected (green): every warning fixture is reported with continuation lines.

### Task 10: Reject warning false positives

**Seam:** `findBuildDiagnostics(output)`.

**Outcome:** Normal Vite output and application text that contains the word `warning` produce no diagnostics.

**Files:**

- Modify: `scripts/frontend-bundle-diagnostics.ts`
- Test: `scripts/frontend-bundle-diagnostics.test.ts`

**Steps:**

- [ ] **Red:** Add fixtures for `✓ built`, `rendering chunks`, asset size rows, ordinary `info` output, and an application string such as `The warning preference is saved`. Assert an empty result.
- [ ] **Green:** Add explicit top-level termination/progress recognition only as needed to pass these fixtures. Keep detection based on diagnostic structure, not general words.

**Validation:**

- Run (red/green): `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts`
- Expected (red): a broad warning match creates a false positive.
- Expected (green): all normal summaries return no diagnostics.

### Task 11: Enforce the zero-warning bundle task

**Seam:** `mise run check:frontend-bundle`.

**Outcome:** Build stdout/stderr are parsed as one stream; build failures keep their status; warning-only builds return 1; clean builds continue to existing manifest checks.

**Files:**

- Modify: `.mise/tasks/check/frontend-bundle`

**Steps:**

- [ ] **Red:** Run the parser test suite and a local shell fixture that pipes a zero-exit command emitting the Vite oversized warning into the same capture/parser sequence. Confirm the current task logic would return zero.
- [ ] **Green:** Around `mise run build 2>&1 | tee "$build_log"`, temporarily disable `errexit`, capture `PIPESTATUS[0]` as `build_status`, then restore `errexit`.
- [ ] Invoke `bun scripts/frontend-bundle-diagnostics.ts "$build_log"` and capture `diagnostic_status` without losing `build_status`.
- [ ] If `build_status != 0`, return that exact status after printing diagnostics. If the build succeeds and diagnostics exist, return 1. Only then run the existing asset/manifest inspector.
- [ ] Remove `BUILD_WARNING_STRINGS` and the fixed-string grep loop. Keep all current language, theme, asset-size, forbidden-token, and dynamic-import checks.

**Validation:**

- Run: `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts`
- Expected: all six required fixture classes pass.
- Run: `mise run check:frontend-bundle`
- Expected: zero only when `mise run build` succeeds, no diagnostic block exists, and all existing bundle assertions pass. An actual Vite oversized-chunk or Rolldown warning prints its full block and returns nonzero.

### Task 12: Format actionable cargo-audit findings

**Seam:** cargo-audit JSON to `scripts/cargo-audit-report.ts` output.

**Outcome:** Every vulnerability row includes advisory ID, package/version, title, patched versions or `UNPATCHED`, and advisory URL.

**Files:**

- Create: `scripts/cargo-audit-report.ts`
- Create: `scripts/cargo-audit-report.test.ts`

**Steps:**

- [ ] **Red:** Add an inline JSON fixture with one patched quick-xml advisory and one unpatched RSA advisory. Assert stable headings and exact field values, including `>=0.41.0` and `UNPATCHED`.
- [ ] **Green:** Parse `vulnerabilities.list`; format a concise table; join multiple patched requirements with `, `; use `UNPATCHED` for an empty patched list; print the advisory URL from JSON.
- [ ] For malformed or missing JSON fields, print a concise reporter error and exit nonzero. Never print advisory descriptions, environment data, or dependency source URLs in the concise table.

**Validation:**

- Run (red/green): `bun test --isolate scripts/cargo-audit-report.test.ts`
- Expected (red): the reporter does not exist.
- Expected (green): patched and unpatched rows match the fixture exactly.

### Task 13: Print dependency paths and preserve cargo-audit failure

**Seam:** `mise run audit:cargo`.

**Outcome:** A failed audit writes JSON, prints the concise table and inverse dependency trees, prints the JSON path, then returns the original nonzero audit status.

**Files:**

- Modify: `.mise/tasks/audit/cargo`

**Steps:**

- [ ] **Red:** Run `mise run audit:cargo` and capture output/status. Confirm the current task returns nonzero but omits advisory details and dependency paths.
- [ ] **Green:** Capture cargo-audit stdout in `.audit/cargo-audit.json`, capture stderr separately, and retain `audit_status` with `set +e`/`set -e`.
- [ ] On failure, run `bun scripts/cargo-audit-report.ts .audit/cargo-audit.json`.
- [ ] Extract unique vulnerable `package@version` pairs from the same JSON. For each pair, print a heading and run `cargo tree --manifest-path src-tauri/Cargo.toml -i "package@version"` so the full inverse path is visible before exit.
- [ ] If a `cargo tree` command fails, print that command and its status as a reporting error, but still return the original `audit_status`.
- [ ] Print `Full report: .audit/cargo-audit.json` last, then `exit "$audit_status"`.
- [ ] Do not add `--ignore`, advisory allowlists, or success coercion.

**Validation:**

- Run: `set +e; output="$(mise run audit:cargo 2>&1)"; status=$?; set -e; printf '%s\n' "$output"; test "$status" -ne 0`
- Expected: output contains all current advisory IDs, package/version pairs, fix status, URLs, an inverse dependency tree for each unique vulnerable version, and the JSON path. Status remains the cargo-audit failure status.

### Task 14: Remove patched quick-xml advisories

**Seam:** `src-tauri/Cargo.lock` through `cargo tree -i` and cargo-audit.

**Outcome:** Neither `quick-xml 0.30.0` nor `quick-xml 0.39.4` remains in a vulnerable path; both quick-xml advisories disappear without suppressions.

**Files:**

- Modify if required: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Steps:**

- [ ] **Red:** Confirm both inverse trees and the four quick-xml advisory rows from the Evidence Gate.
- [ ] For each inverse tree, identify the nearest dependency declared directly in `src-tauri/Cargo.toml`. First try a lockfile-only compatible update of that parent with `cargo update --manifest-path src-tauri/Cargo.toml -p <exact-parent-package> --precise <compatible-version>`.
- [ ] If the parent's current manifest constraint blocks the first non-vulnerable release, change only that direct dependency's version requirement to the smallest current release line that resolves `quick-xml >=0.41.0`, then update the lockfile. Verify the chosen release against current crate documentation/changelog before editing.
- [ ] Do not add a direct `quick-xml` dependency solely to force resolution. Do not use `[patch]`, vendoring, or advisory ignores unless separately authorized.
- [ ] **Green:** Re-run both `cargo tree -i` commands and `mise run audit:cargo`. Confirm all four quick-xml rows are gone.
- [ ] Run the targeted Rust tests for every direct parent package or feature affected by the dependency update, followed by the full Rust suite.

**Validation:**

- Run: `cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.30.0`
- Expected: Cargo reports that version is not present.
- Run: `cargo tree --manifest-path src-tauri/Cargo.toml -i quick-xml@0.39.4`
- Expected: Cargo reports that version is not present.
- Run: `mise run test`
- Expected: all Rust tests pass.
- Run: `mise run audit:cargo`
- Expected: still nonzero only if an unsuppressed vulnerability remains, including `RUSTSEC-2023-0071` while unpatched; no quick-xml vulnerability row remains.

### Task 15: Report the unpatched RSA blocker precisely

**Seam:** `mise run audit:cargo` output and status.

**Outcome:** `RUSTSEC-2023-0071` remains visible with its actual inverse dependency path, `UNPATCHED` status, URL, and nonzero exit until an upstream fix or safe dependency removal exists.

**Files:**

- Modify only if the Evidence Gate proves RSA is removable without product behavior loss: `src-tauri/Cargo.toml`
- Modify only with that safe removal: `src-tauri/Cargo.lock`
- Otherwise: no dependency file change

**Steps:**

- [ ] Inspect `cargo tree --manifest-path src-tauri/Cargo.toml -i rsa@0.9.10` and the features of every direct parent in the path.
- [ ] If RSA supports required production behavior, including Google service-account RS256 signing, do not remove it or change cryptographic behavior in this scope.
- [ ] If the path is provably unused and a documented feature change removes RSA without changing supported behavior, first add/run the relevant public workflow test, then make the minimal feature/dependency change.
- [ ] Otherwise, keep the lockfile entry and audit failure. Report: advisory ID, `rsa 0.9.10`, full inverse path, no patched versions, affected feature/workflow, and the upstream advisory URL.
- [ ] Never ignore or downgrade the advisory and never convert the audit task to success.

**Validation:**

- Run: `mise run audit:cargo`
- Expected blocker case: nonzero; `RUSTSEC-2023-0071`, `rsa 0.9.10`, `UNPATCHED`, its dependency tree, URL, and `.audit/cargo-audit.json` are printed.
- Expected safe-removal case: zero only if no vulnerability remains and the full Rust tests prove required behavior still works.

### Task 16: Close all frontend regressions by behavior

**Seam:** Each residual public interface named by `bun test --isolate src`, with the full frontend suite as the acceptance seam.

**Outcome:** Every baseline failure passes because production behavior is correct; no assertion, timeout, skip, or fixture is weakened to hide a regression.

**Files:**

- Modify/Test: the exact residual files recorded by the Evidence Gate

**Steps:**

- [ ] Run `bun test --isolate src` after Tasks 1-11. Compare failures by exact test identity against the baseline.
- [ ] For each distinct root cause, perform one vertical cycle: select the existing public seam, run that exact test file to prove red, make the smallest production fix, then rerun the exact file to green before moving to the next cause.
- [ ] Treat failures removed by Tasks 1-11 as resolved only when their original assertions pass unchanged or are replaced by stronger assertions required by the restored loading behavior.
- [ ] Do not increase `HIGHLIGHT_CALLBACK_TIMEOUT_MS`, loosen equality/DOM/accessibility assertions, add retries, add `.skip`/`.todo`, or delete coverage merely to reach green.
- [ ] If a baseline assertion conflicts with the supplied required behavior, replace it only with the explicit required contract and record the old/new behavior in the implementation report.
- [ ] Continue until the full command reports zero failures. If any failure is pre-existing and outside the supplied findings, report its exact test, error, and evidence as a blocker; do not claim completion.

**Validation:**

- Run (red): each exact residual test command, `bun test --isolate <recorded-test-path>`
- Expected (red): the original behavior failure reproduces before its fix.
- Run (green): the same exact command after its minimal fix.
- Expected (green): that test file passes without weakened assertions.
- Run: `bun test --isolate src`
- Expected: zero failures; all previously reported 36 test identities, or the corrected observed baseline, pass.

### Task 17: Normalize `cache.rs` without semantic churn

**Seam:** Git's normalized diff for `src-tauri/src/services/wasm_runtime/cache.rs`.

**Outcome:** The file uses LF, has no trailing spaces/tabs, has one final newline, preserves both `ABOUTME` lines, and has no semantic change introduced by this task.

**Files:**

- Modify: `src-tauri/src/services/wasm_runtime/cache.rs`

**Steps:**

- [ ] **Red:** Use the Evidence Gate EOL and diff output to prove CRLF or trailing-whitespace churn. Compare both working and staged views with `git diff` and `git diff --cached`.
- [ ] Normalize only this file: convert `\r\n`/`\r` to `\n`, remove trailing spaces/tabs, and enforce exactly one final newline. Do not run a broad formatter write across unrelated files.
- [ ] Preserve all Rust tokens, comments, indentation width, test names, and the existing bounded LRU implementation.
- [ ] **Green:** Verify `git diff --ignore-space-at-eol --word-diff=porcelain -- src-tauri/src/services/wasm_runtime/cache.rs` contains no semantic token change attributable to normalization. If a pre-existing semantic change exists, preserve it and compare it separately against `HEAD`/the staged version.

**Validation:**

- Run: `git diff --numstat -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: no full-file add/delete churn; counts reflect only any pre-existing semantic lines.
- Run: `git diff --check -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: no output.
- Run: `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: index/worktree report LF, not CRLF or mixed endings.
- Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- Expected: success without rewriting the file.

## Final Validation

Run in this order:

1. `bun test --isolate src/components/markdown/-codeHighlighter.test.ts`
   - Expected: all collision, LRU, retry, in-flight, language, theme, and dependency-policy tests pass.
2. `bun test --isolate src/components/markdown/LazyMarkdownOutput.test.tsx`
   - Expected: accessible non-empty fallback and deferred Markdown tests pass.
3. `bun test --isolate scripts/frontend-bundle-diagnostics.test.ts scripts/cargo-audit-report.test.ts`
   - Expected: all parser/reporter fixtures pass.
4. `bun test --isolate src`
   - Expected: zero failures. The confirmed baseline set of 36 failures is fully resolved through behavior.
5. `mise run typecheck`
   - Expected: success.
6. `mise run lint`
   - Expected: ESLint and oxlint both succeed.
7. `mise run format:check`
   - Expected: oxfmt and cargo fmt both succeed; `src/routeTree.gen.ts` remains untouched.
8. `mise run build`
   - Expected: frontend typecheck/build succeeds.
9. `mise run check:frontend-bundle`
   - Expected: success with no Vite/Rolldown warning block, no oversized Markdown/Shiki asset, allowlisted grammars/themes only, and lazy Markdown route imports preserved.
10. `mise run test`
    - Expected: all Rust unit and integration tests pass.
11. `mise run audit:cargo`
    - Expected if RSA is still required and unpatched: nonzero with only current unsuppressed blockers; `RUSTSEC-2023-0071` is printed with package/version, full dependency path, `UNPATCHED`, URL, and report path. No quick-xml advisory remains.
    - Expected if RSA is safely removed or patched upstream: zero and an empty vulnerability list.
12. `git diff --check`
    - Expected: no whitespace errors.
13. `git diff --numstat -- src-tauri/src/services/wasm_runtime/cache.rs` and `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`
    - Expected: minimal diff and LF-only state.
14. Review `git diff` and `git diff --cached` separately.
    - Expected: only in-scope implementation, tests, task scripts, dependency resolution, audit artifact refresh, and byte normalization are present. No generated `src/routeTree.gen.ts` edit and no unrelated cleanup.

## Failure Behavior

- Unknown Markdown language — return `null`; do not load a grammar.
- Highlight load failure — log the language and error without code text, clear callbacks/in-flight state, remember a bounded failure, and allow retry only after LRU eviction.
- Evicted highlighter promise — let existing callers finish; recreate it only for later uncached work.
- Lazy Markdown module pending — render retained text/loading status through `TextLoading`; never blank the pane.
- Frontend build process failure — print captured diagnostics and return the original build status.
- Successful build with any recognized Vite/Rolldown warning — print the complete warning block and return 1.
- Malformed cargo-audit JSON — report the parse error and preserve the original audit failure status.
- cargo-audit vulnerability — print actionable fields and dependency paths, then return the original nonzero status.
- Unpatched RSA advisory — remain an explicit external blocker; no suppression or false success.
- Dependency update breaks required behavior — revert the dependency attempt and report the exact parent constraint/test failure.

## Privacy and Security

- Do not print highlighted source code in cache or loader errors.
- cargo-audit output can include package metadata but must not include secrets, credentials, environment values, or private key material.
- Keep RS256 service-account behavior intact unless a tested, documented replacement removes RSA safely.
- Do not disable or ignore RustSec advisories. A known unpatched vulnerability must remain visible and fail the gate.
- Treat exact code strings retained in the token cache as potentially sensitive. The 128-entry bound limits lifetime retention; do not add persistence or telemetry.

## Rollout Notes

- No data migration or user configuration change is required.
- Commit `.audit/cargo-audit.json` only if repository policy already treats it as a tracked audit artifact and the refreshed file is part of the requested change.
- The bundle gate becomes stricter. CI can newly fail on warnings that previously passed; this is intended.
- The audit gate can remain red because of `RUSTSEC-2023-0071`. Report that result as an external blocker, not as implementation failure or success.

## Risks and Mitigations

- **LRU tests are slow because real Shiki loaders run many times.** Use controllable injected language loaders where the public option supports them, keep timeouts bounded, and avoid production-only test hooks.
- **A rejected highlighter promise can poison retries.** Remove only the matching rejected map entry and cover retry behavior through the public plugin.
- **Broad warning matching can reject normal output.** Anchor diagnostic prefixes and retain explicit negative fixtures.
- **Warning continuation parsing can truncate useful guidance.** Assert exact multiline fixture equality.
- **Transitive quick-xml constraints can block 0.41.0.** Use the confirmed inverse tree, update the nearest direct parent minimally, and report the exact constraint if no compatible release exists.
- **RSA removal can break Google service-account signing.** Preserve the dependency unless public workflow tests and current dependency documentation prove a safe replacement.
- **Line-ending normalization can hide semantic edits.** Compare working and staged diffs, use whitespace-ignoring token review, and normalize only `cache.rs`.
- **The supplied 36-failure count can be stale.** Use the executed baseline as source of truth and report the discrepancy without loosening tests.

## Out of Scope

- Changing the Markdown language/theme allowlist.
- Replacing Streamdown, Shiki, React Suspense, or the existing translation state architecture.
- Raising `build.chunkSizeWarningLimit` to hide oversized chunks.
- Suppressing, ignoring, downgrading, or accepting RustSec advisories as success.
- Broad Cargo dependency modernization beyond the direct parents required to resolve the two vulnerable quick-xml versions.
- Semantic changes to the compiled Wasm component cache.
- Unrelated formatting, generated route-tree edits, staging, commits, or deployment changes.

## Open Questions

- Which exact tests make up the reported 36 failures? The Evidence Gate resolves this before edits.
- Which direct dependencies introduce `quick-xml 0.30.0`, `quick-xml 0.39.4`, and `rsa 0.9.10`? The required `cargo tree -i` commands resolve this before dependency edits.
- Does the current index contain a prior `TextLoading` implementation or semantic `cache.rs` change that must be preserved? The staged-diff checks resolve this before edits.
- If no compatible direct-parent upgrade can resolve a quick-xml path, the unresolved parent constraint becomes an external blocker with the exact package/version/path. It must not be ignored.
