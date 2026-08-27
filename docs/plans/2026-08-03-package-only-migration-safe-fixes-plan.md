# Implementation Plan

**Goal:** Finish the package-only migration with measured frontend chunk reduction, a Windows-safe Rust test gate, clean lint and format output, controlled EOL handling, and zero unsuppressed dependency advisories.

**Inputs:** Mr. Julian's read-only inspection; repository files inspected on 2026-08-03; Vite 8 documentation from Context7 `/vitejs/vite`; jsonwebtoken 11 documentation from Context7 `/keats/jsonwebtoken`; RustSec advisories RUSTSEC-2026-0194, RUSTSEC-2026-0195, and RUSTSEC-2023-0071.

**Assumptions:**

- The implementation baseline is the merge-base of the current `package-only-migration` worktree and its target branch. The executor must record that commit before changing files.
- The user declined seam confirmation. The executor must confirm the seams below before writing new tests. If the user changes a seam, update this plan first.
- `src-tauri/Cargo.lock` is authoritative. It currently resolves `xcap 0.9.6 → xcb 1.7.1 → quick-xml 0.41.0` and contains no `rsa` package.
- The existing highlighter cache and promise identity guards are intentional and stay unchanged unless a focused test or lint diagnostic proves a defect.
- The implementation must not raise `build.chunkSizeWarningLimit`, add audit ignores, add lint disables, or add a blanket `node_modules` vendor group.

**Architecture:** Keep the React-to-Markdown dynamic import as the lazy boundary. Use targeted Rolldown groups only to reduce emitted JavaScript chunks, and verify the result from the Vite manifest and emitted files. Keep dependency remediation in Cargo resolution: use released crates and the lockfile when possible, and stop with an exact reverse-dependency blocker when no patched production path exists.

**Tech Stack:** Vite 8, Rolldown code splitting, React 19, Streamdown 2, Shiki 3, Bun tests, ESLint 10, oxlint, oxfmt, Rust 1.96, Cargo, cargo-audit, mise, PowerShell and Bash task wrappers.

---

## Evidence Baseline

Before implementation, save the full output of these read-only commands in the work log. Do not add the output files to the change set.

```bash
git status --short
git diff --stat
git diff --numstat
git diff --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs
mise run typecheck
mise run build
mise run lint
mise run format:check
mise run test-frontend
mise run test
cargo tree --manifest-path src-tauri/Cargo.toml --target all -i quick-xml@0.41.0
cargo tree --manifest-path src-tauri/Cargo.toml --target all -i rsa
mise run audit:cargo
```

Record:

- The exact files reported by `mise run format:check`.
- Every ESLint diagnostic, including the file, line, rule, and message.
- Every emitted JavaScript file larger than 450 KiB and the largest emitted JavaScript file.
- Whether Vite prints `Some chunks are larger than 500 kB`.
- The reverse dependency paths for `quick-xml` and `rsa`.
- The exact Windows temp-path failure, if `mise run test` fails.

If the baseline does not reproduce a reported failure, do not invent a code change. Keep the corresponding task as verification-only and record the passing evidence.

## File Map

- Modify: `vite.config.ts` — keep the Markdown lazy boundary and tune only the specific Rolldown group that still exceeds the production chunk limit.
- Create: `scripts/check-frontend-bundle.ts` — validate emitted JavaScript size and the initial-entry/static-import boundary from the Vite manifest.
- Create: `scripts/check-frontend-bundle.test.ts` — test the bundle checker with small manifest/file fixtures through its public function.
- Create: `.mise/tasks/check/bundle` — run the bundle checker after a production build as `mise run check:bundle`.
- Modify: `.mise/tasks/test` — only if Windows reproduces the temp-path gate; provide worktree-local `TEMP`, `TMP`, and `CARGO_TARGET_DIR` for the Rust test process.
- Modify: `.gitignore` — only if the Windows task creates new worktree-local runtime directories; ignore those directories without broad patterns.
- Modify: the exact lint source file reported by `mise run lint` — preserve the original caught value or attach it as `Error.cause`; do not assume `src/components/markdown/-codeHighlighter.ts` is the failing file.
- Test: the existing test next to that lint source — add an error identity or `cause` assertion only when runtime behavior changes.
- Modify: the exact three files reported by `mise run format:check` — apply targeted oxfmt or rustfmt changes only.
- Inspect or restore: `src-tauri/src/services/wasm_runtime/cache.rs` — remove EOL-only worktree churn without changing Rust behavior.
- Modify: `.gitattributes` — keep the existing narrow `cache.rs text eol=lf` rule only if it is part of the intended migration and does not force an unrelated full-file semantic diff.
- Modify: `README.md` — replace stale Prettier references with oxfmt so user-facing task documentation matches `AGENTS.md`, `.oxfmtrc.json`, and the mise tasks.
- Modify: `src-tauri/Cargo.lock` — only when Cargo resolution is required to remove an advisory.
- Modify: `src-tauri/Cargo.toml` — only if the published `xcap 0.9.6` resolution cannot be retained from the current semver declaration; do not change jsonwebtoken's AWS-LC feature selection.

All created code and task files must start with the required two-line `ABOUTME:` header. Do not edit generated `src/routeTree.gen.ts`.

## Seams

- **Seam:** `mise run build` plus `dist/.vite/manifest.json` and emitted `dist/assets/*.js` — verifies that every JavaScript chunk stays below Vite's 500 kB warning boundary and that Markdown/Shiki code is absent from the initial static import closure.
- **Seam:** `createMarkdownCodeHighlighter()` through the Streamdown `CodeHighlighterPlugin` interface — verifies that lazy grammars, cache bounds, request identity, and original error handling remain intact after bundle or lint work.
- **Seam:** `mise run test` on Windows with caller `TEMP`, `TMP`, and `CARGO_TARGET_DIR` unset or outside the worktree — verifies that Rust tests use task-owned worktree-local paths without changing product code.
- **Seam:** `mise run lint` and the affected module's public error result — verifies zero lint diagnostics without suppressing `preserve-caught-error` and preserves error identity or `cause`.
- **Seam:** `mise run format:check` plus `git diff --ignore-space-at-eol` — verifies targeted formatting and distinguishes semantic edits from EOL-only churn.
- **Seam:** `src-tauri/Cargo.lock`, `cargo tree --target all -i <crate>`, and `mise run audit:cargo` — verifies that production dependency paths contain `quick-xml >= 0.41.0`, contain no vulnerable `rsa`, and use no audit suppression.

## Tasks

### Task 1: Add a production bundle contract

**Seam:** `mise run build` plus `dist/.vite/manifest.json` and emitted `dist/assets/*.js`.

**Outcome:** The repository has a repeatable check for real emitted chunk size and the Markdown lazy boundary. The production build emits no chunk-size warning.

**Files:**

- Create: `scripts/check-frontend-bundle.test.ts`
- Create: `scripts/check-frontend-bundle.ts`
- Create: `.mise/tasks/check/bundle`
- Modify: `vite.config.ts` only if the measured build still fails

**Steps:**

- [ ] Confirm the bundle seam before writing the test.
- [ ] **Red:** Add fixture-based tests for an exported `checkFrontendBundle(options)` function. Cover: one JavaScript asset at or above `500_000` bytes fails; an asset below the limit passes; a manifest whose initial static import closure reaches `src/components/markdown/MarkdownOutput.tsx`, `@shikijs/langs`, or `@shikijs/themes` fails; the same records referenced only through `dynamicImports` pass; missing manifest/assets fail with actionable paths.
- [ ] **Green:** Implement `scripts/check-frontend-bundle.ts` with named constants for `500_000` bytes, the Vite manifest path, the application entry, and the forbidden lazy module keys or prefixes. Traverse only static `imports` from the application entry. Treat `dynamicImports` as lazy edges. Report every oversize asset and every forbidden static path before exiting nonzero.
- [ ] Add `.mise/tasks/check/bundle` to run `bun scripts/check-frontend-bundle.ts` from the repository root. The task must not build implicitly; this keeps build and inspection failures distinct.
- [ ] Run `mise run build`, then `mise run check:bundle`. Save the Vite warning output and the checker's largest-asset report.
- [ ] If both commands pass, do not change the existing groups. The current targeted groups are `streamdown`, `shiki-core`, and `shell-vendor`, each capped at `450 * 1024` bytes.
- [ ] If a chunk still fails, use the Vite manifest to identify its owning modules. Change only the responsible existing group or add one package-specific group. Keep `@shikijs/langs` and `@shikijs/themes` excluded from `shiki-core`. Keep `includeDependenciesRecursively: false` on Streamdown and Shiki core. Do not add a global vendor group.
- [ ] Re-run the focused highlighter tests to prove that grammar/theme loading behavior did not change.

**Validation:**

- Run (red): `bun test scripts/check-frontend-bundle.test.ts`
- Expected: the test fails because `checkFrontendBundle` or its required behavior does not exist.
- Run (green): `bun test scripts/check-frontend-bundle.test.ts`
- Expected: all checker scenarios pass.
- Run: `mise run build && mise run check:bundle`
- Expected: Vite prints no `Some chunks are larger than 500 kB`; every emitted JavaScript file is below `500_000` bytes; the initial static closure excludes `MarkdownOutput.tsx` and its Shiki grammar/theme loaders.
- Run: `bun test src/components/markdown/-codeHighlighter.test.ts`
- Expected: all language, cache, collision, LRU, and in-flight callback contracts pass.

### Task 2: Make the Rust test gate Windows-safe

**Seam:** `mise run test` on Windows with external temp variables.

**Outcome:** The project test task owns deterministic worktree-local temp and target paths on Windows. No temporary output can enter version control.

**Files:**

- Modify: `.mise/tasks/test` only after reproduction
- Modify: `.gitignore` only if new directories are introduced

**Steps:**

- [ ] Confirm the Windows test-task seam before changing the task.
- [ ] **Red:** On Windows, clear task-specific overrides and run `mise run test` while the parent environment points `TEMP` or `TMP` outside the worktree. Capture the exact failing gate and path. If the failure is unrelated, stop this task and create a blocker with that output.
- [ ] **Green:** In `.mise/tasks/test`, resolve the repository root from `MISE_PROJECT_ROOT` with the existing script-location fallback. When `OS=Windows_NT`, create narrow runtime directories such as `.tmp/rust-tests` and `.cargo-target/rust-tests`, then export `TEMP`, `TMP`, and `CARGO_TARGET_DIR` to those absolute paths before `cargo test`. Leave non-Windows behavior unchanged.
- [ ] Add only `/.tmp/` and `/.cargo-target/` to `.gitignore`. Do not ignore generic `tmp`, `target`, or parent directories.
- [ ] Preserve optional Cargo test argument forwarding exactly as `"$@"`.
- [ ] Run the task twice: once with external parent temp variables and once with explicit valid worktree-local values. Both runs must pass, and `git status --short` must not show runtime files.

**Validation:**

- Run (red, PowerShell): `$env:TEMP = "$env:USERPROFILE\AppData\Local\Temp"; $env:TMP = $env:TEMP; Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue; mise run test`
- Expected: the known gate fails and prints an external path. If it does not fail, make no task change and record the gate as not reproduced.
- Run (green, PowerShell): use the same command after the task change.
- Expected: Rust tests pass; diagnostics show worktree-local task paths when the gate reports paths.
- Run: `git status --short -- .tmp .cargo-target`
- Expected: no tracked or untracked runtime files are reported.

### Task 3: Fix lint diagnostics without suppressions

**Seam:** `mise run lint` and the affected module's public error behavior.

**Outcome:** ESLint and oxlint pass. Any caught error remains observable as the same value or as `Error.cause`.

**Files:**

- Modify: exact source path from the baseline lint output
- Test: nearest existing public-interface test for that source, only if behavior changes

**Steps:**

- [ ] Run `mise run lint` and classify each diagnostic by exact file and rule. Do not assume the highlighter rejection callback is wrong: it currently rethrows the original caught value.
- [ ] If `preserve-caught-error` points to code that replaces a caught value with a new `Error`, confirm that module's public seam.
- [ ] **Red:** Add one focused test that catches the public rejection/error and asserts either object identity with the original thrown value or `result.cause === originalError`, according to the module contract.
- [ ] **Green:** Use `throw error` when no translation is required. When context must be added, use `new Error(message, { cause: error })`. Do not stringify and discard the caught value. Do not add eslint-disable comments or rule overrides.
- [ ] If lint passes without source changes, keep `src/components/markdown/-codeHighlighter.ts` unchanged and record this task as verification-only.

**Validation:**

- Run (red): the nearest focused Bun test command, for example `bun test path/to/affected.test.ts`
- Expected: the new identity or `cause` assertion fails against the faulty error replacement.
- Run (green): the same focused test.
- Expected: the public error preserves identity or `cause`.
- Run: `mise run lint`
- Expected: ESLint and oxlint exit zero with no errors; no suppression was added.

### Task 4: Resolve format failures and EOL churn narrowly

**Seam:** `mise run format:check` plus semantic and EOL-aware Git diffs.

**Outcome:** All format checks pass. Only the reported files change. `cache.rs` has no accidental semantic edit or whole-file formatting rewrite.

**Files:**

- Modify: the exact files reported by `mise run format:check`
- Inspect or restore: `src-tauri/src/services/wasm_runtime/cache.rs`
- Modify: `.gitattributes` only under the rule in the File Map
- Modify: `README.md`

**Steps:**

- [ ] **Red:** Run `mise run format:check`; save the exact failing file list. Run `git diff --numstat` and `git diff --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs`.
- [ ] For each reported TypeScript, JavaScript, JSON, Markdown, or CSS file, run `bunx oxfmt <exact-path>` only on that file. For each reported Rust file, run `mise exec -- rustfmt --edition 2024 <exact-path>` only on that file. Do not run the repository-wide write formatter.
- [ ] Update `README.md` from `ESLint + Prettier` to `ESLint + oxfmt`, and update the format task descriptions from Prettier to oxfmt.
- [ ] If the EOL-ignored `cache.rs` diff is non-empty, treat it as semantic and review each changed hunk. Keep only changes required by another task; otherwise obtain approval before restoring the file from the recorded baseline.
- [ ] If the EOL-ignored diff is empty but the normal diff shows the entire file, restore the baseline content after approval. Keep the narrow `.gitattributes` LF rule only if Git then reports no unintended `cache.rs` worktree diff. Do not run rustfmt on `cache.rs` merely to normalize line endings.
- [ ] **Green:** Re-run formatting and both Git diff forms. Verify that no unreported file was rewritten.

**Validation:**

- Run (red): `mise run format:check`
- Expected: it reports the known failing files and exits nonzero.
- Run (green): `mise run format:check`
- Expected: oxfmt and cargo fmt checks exit zero.
- Run: `git diff --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: empty unless a separately tested semantic fix requires that file.
- Run: `git diff --numstat`
- Expected: no unexplained whole-file delete/add count and no formatter changes outside the baseline failure list, `README.md`, or files required by another task.

### Task 5: Prove or remediate Rust advisories

**Seam:** `src-tauri/Cargo.lock`, Cargo reverse dependency trees, and `mise run audit:cargo`.

**Outcome:** The lockfile contains patched `quick-xml`, no vulnerable `rsa`, and cargo-audit exits zero. If Cargo cannot produce that graph, the task stops with an exact production dependency blocker rather than a suppression.

**Files:**

- Modify: `src-tauri/Cargo.lock` only if resolution changes
- Modify: `src-tauri/Cargo.toml` only if the released xcap requirement must be tightened

**Steps:**

- [ ] **Red:** Run `mise run audit:cargo`. Also run reverse trees with `--target all` so platform-specific `xcap`/`xcb` edges are included. Save the advisory IDs and exact package versions.
- [ ] Verify the current expected safe graph: `xcap 0.9.6 → xcb 1.7.1 → quick-xml 0.41.0`. Verify that `cargo tree --target all -i rsa` reports no matching package.
- [ ] If audit passes and both graph checks match, do not modify `Cargo.toml` or regenerate the lockfile. This is the preferred result.
- [ ] If `quick-xml < 0.41.0` appears, first run `cargo update --manifest-path src-tauri/Cargo.toml -p xcap --precise 0.9.6`. Accept the lockfile only if the reverse tree resolves `xcb 1.7.1` and `quick-xml >= 0.41.0`, Rust tests pass, and no unrelated direct dependency changes.
- [ ] If the `xcap = "0.9"` requirement does not retain that safe published graph, tighten it to `xcap = "0.9.6"`, regenerate only the affected lock entries, and repeat the graph and test checks.
- [ ] Do not use `cargo update -p quick-xml --precise 0.41.0` to cross an incompatible `xcb` constraint. Do not add a `[patch]` git dependency unless released `xcap 0.9.6` is unavailable or demonstrably resolves to a vulnerable graph.
- [ ] If a git patch becomes necessary, stop before the external-source change. Record the exact `xcap → xcb → quick-xml` tree, the candidate upstream commit, its immutable SHA, license, and evidence that it requires `quick-xml >= 0.41.0`; obtain approval before adding the patch.
- [ ] If `rsa` appears, run `cargo tree --manifest-path src-tauri/Cargo.toml --target all -e features -i rsa` and `cargo tree --manifest-path src-tauri/Cargo.toml --target all -e features -i jsonwebtoken`. Keep `jsonwebtoken = { version = "11.0.0", default-features = false, features = ["use_pem", "aws_lc_rs"] }` unchanged unless the tree proves feature unification enabled `rust_crypto`.
- [ ] Remove the production edge that enables `rsa` when a maintained backend exists. If an unavoidable production dependency still requires `rsa`, stop release validation. Record the exact crate/version/feature chain and upstream issue. RUSTSEC-2023-0071 has no patched version, so audit suppression is not an acceptable completion state.
- [ ] Apply the same rule to any additional production vulnerability in the cargo-audit report: remediate its exact reverse dependency path or stop with the package/version/feature chain and upstream status. Do not silently narrow the task to `quick-xml` and `rsa`.
- [ ] Ensure `.mise/tasks/audit/cargo` continues to audit `src-tauri/Cargo.lock` and exits with cargo-audit's nonzero status. Do not add ignore IDs, allowlists, or advisory filters.

**Validation:**

- Run (red): `mise run audit:cargo`
- Expected: either the reported advisory reproduces with an exact reverse tree, or the command passes and no dependency edit is needed.
- Run (green): `cargo tree --manifest-path src-tauri/Cargo.toml --target all -i quick-xml@0.41.0`
- Expected: the path includes `xcb 1.7.1` and `xcap 0.9.6`; no older `quick-xml` package appears in the audit report.
- Run: `cargo tree --manifest-path src-tauri/Cargo.toml --target all -i rsa`
- Expected: Cargo reports that `rsa` does not match any package in the graph.
- Run: `mise run audit:cargo`
- Expected: exit zero with zero vulnerabilities and no ignored advisories.
- Run: `mise run test`
- Expected: all Rust tests pass with the final lockfile.

### Task 6: Run the complete release gate

**Seam:** All confirmed seams above.

**Outcome:** The scoped migration is ready for review with full passing evidence and a clean, explainable diff.

**Files:**

- Modify: none unless a validation failure returns work to its owning task

**Steps:**

- [ ] Run the commands below in order. Stop at the first failure and return to the task that owns that seam.
- [ ] Inspect `git diff --check`, normal diff, EOL-ignored `cache.rs` diff, and numstat. Remove generated `dist`, `.audit`, `.tmp`, and `.cargo-target` content from the review surface through existing ignore rules; do not stage or commit.
- [ ] Manually launch the frontend once and open a route that does not render Markdown. Confirm in webview DevTools that no `MarkdownOutput`, Streamdown, Shiki grammar, or Shiki theme chunk loads. Then render Markdown with one allowlisted fenced language and confirm that only the renderer, selected grammar, and configured themes load on demand.
- [ ] Record the largest JavaScript asset, the Markdown lazy-load observation, the safe Cargo trees, and all command exit statuses in the handoff.

**Validation:**

- Run: `mise run typecheck`
- Expected: exit zero.
- Run: `mise run build`
- Expected: exit zero with no chunk larger than 500 kB warning.
- Run: `mise run check:bundle`
- Expected: exit zero; all JavaScript assets are below `500_000` bytes and the initial static graph excludes Markdown.
- Run: `mise run lint`
- Expected: ESLint and oxlint exit zero without suppressions.
- Run: `mise run format:check`
- Expected: oxfmt and rustfmt checks exit zero.
- Run: `mise run test-frontend`
- Expected: all frontend tests pass.
- Run: `mise run test`
- Expected: all Rust tests pass under the Windows-safe task environment when run on Windows.
- Run: `mise run audit:cargo`
- Expected: exit zero with no ignored advisory.
- Run: `git diff --check`
- Expected: no whitespace errors.
- Run: `git diff --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: empty unless a separately justified semantic change exists.

## Failure Behavior

- A missing or malformed Vite manifest, a missing emitted asset, an oversize JavaScript chunk, or a static Markdown edge makes `mise run check:bundle` fail with the exact path.
- A Windows test task cannot create its worktree-local directories: exit before Cargo runs and print the failed directory path.
- A caught error needs translation: preserve the original value in `cause`; never replace it silently.
- A targeted formatter changes unrelated lines: restore that file after approval and apply a smaller edit.
- Cargo cannot resolve `quick-xml >= 0.41.0` through a released xcap path: stop and request approval for an immutable upstream patch.
- Any production path still includes `rsa`: block completion with the exact feature tree because no patched crate version exists.

## Privacy and Security

- Bundle checks read only generated manifest metadata and file sizes. They must not print source contents.
- Test temp paths contain build and test artifacts only. Do not place credentials in `.tmp` or `.cargo-target`.
- Keep cargo-audit output under ignored `.audit/`. Do not suppress or redact advisory IDs, package versions, or dependency paths.
- Do not log JWT keys, service-account JSON, Markdown source, or application credentials during validation.

## Rollout Notes

- Merge the bundle contract, task wrapper, hygiene fixes, and lockfile remediation as one scoped migration only if all gates pass together.
- Do not commit generated `dist`, `.audit`, `.tmp`, or `.cargo-target` directories.
- Do not stage or commit during implementation unless Mr. Julian asks.
- Run the Windows-specific gate on a Windows host. Run the normal Rust suite on another supported host when CI or release policy requires it.

## Risks and Mitigations

- **Rolldown group changes can pull React or Shiki grammars into the initial graph.** Use manifest static-closure validation and retain the existing package exclusions.
- **A size-only check can miss lazy-boundary regression.** Check both emitted bytes and manifest edge types.
- **Global formatter execution can recreate `cache.rs` churn.** Format only the reported paths, then inspect normal and EOL-ignored diffs.
- **A broad temp ignore can hide source files.** Ignore only root `/.tmp/` and `/.cargo-target/`.
- **Cargo target selection can hide Linux-only xcap dependencies on Windows.** Use `cargo tree --target all` for advisory diagnosis.
- **A stale audit artifact can be mistaken for the active lockfile.** Run `mise run audit:cargo`, which explicitly audits `src-tauri/Cargo.lock`, and compare its timestamp/output in the work log.

## Out of Scope

- Rewriting the Markdown renderer or highlighter cache.
- Raising Vite warning thresholds or accepting larger chunks.
- Adding a global vendor chunk.
- Changing JWT algorithms, key formats, or the AWS-LC backend without a proven dependency feature conflict.
- Repository-wide EOL normalization or formatting.
- Suppressing ESLint, rustfmt, Vite, cargo-audit, or RustSec diagnostics.

## Open Questions

- The exact baseline diff and the three format-failing files still require command output from an environment with Git and the project toolchain.
- The Windows temp-path gate must be reproduced before `.mise/tasks/test` changes. If it does not reproduce, keep the task unchanged.
- The recommended seams are not user-confirmed because the confirmation prompt was declined. Confirm them before adding tests.
