# Implementation Plan

**Goal:** Make the package-only migration pass frontend bundle, cross-platform diagnostics, lint, format, build, and Rust security gates without warning-limit increases, advisory suppression, or unrelated source changes.

**Inputs:** The supplied investigation summary; repository source, tests, generated Vite manifest, mise tasks, and lockfile; current Vite 8, Rolldown, `jsonwebtoken`, `xcap`, `xcb`, and RustSec evidence retrieved on 2026-08-18.

**Assumptions:**

- The supplied requirements confirm the seams below. No additional seam confirmation is required before implementation.
- The three staged formatting paths are not available through the current read-only repository interface. The implementation must discover them with the exact Git commands in Task 4 before it changes formatting.
- `src-tauri/src/services/wasm_runtime/cache.rs` is the reported `cache.rs` file. Its current logic and tests are baseline behavior. Only an LF policy and an EOL-only rewrite are in scope.
- CI or equivalent build hosts are available for Windows, Linux, and macOS. Hardware-backed screenshot smoke checks run on those hosts.
- A live Google OAuth call is out of scope because it needs a real private key and performs an external write. The existing scripted transport is the token-exchange seam.

**Architecture:** Keep Markdown lazy at the route boundary and use Vite 8/Rolldown size-bounded code-splitting groups for Streamdown and Shiki core. Keep the eight grammar modules and two themes as independent dynamic entries. Make the bundle conformance task create one native temporary directory and validate the generated manifest and asset sizes. Remove the Rust advisories by selecting the current `aws_lc_rs` JWT backend and the published `xcb 1.7.1` release, then prove behavior and dependency closure through tests, Cargo graph checks, and `cargo-audit`.

**Tech Stack:** Bun 1.3, TypeScript, Vite 8, Rolldown `output.codeSplitting`, React 19, Streamdown, Shiki 3, Bash/mise, Rust 1.96.1, Cargo, Tauri 2, `jsonwebtoken` 11, `aws-lc-rs`, `xcap`, `xcb 1.7.1`, `quick-xml 0.41`, cargo-audit 0.22.2.

**Evidence decisions:**

- Do not implement the supplied `manualChunks` example. Current Vite 8 documentation says `manualChunks` was removed and directs projects to [`build.rolldownOptions.output.codeSplitting`](https://github.com/vitejs/vite/blob/main/docs/guide/build.md). Rolldown supports named groups with `test`, `priority`, and `maxSize` in [`OutputOptions.codeSplitting`](https://github.com/rolldown/rolldown/blob/main/packages/rolldown/src/options/docs/output-code-splitting-example.md).
- Do not raise `build.chunkSizeWarningLimit`. Vite compares the default 500 kB limit against uncompressed JavaScript chunk size. The plan must reduce or split the emitted chunk.
- Do not add a Git patch for `xcb`. `xcb 1.7.1` is now published on crates.io and its build dependency is `quick-xml = "0.41"`. The current `xcap` requirement `xcb = "1.7"` accepts it.
- Do not waive `RUSTSEC-2023-0071`. `jsonwebtoken` supports one selected backend, and `aws_lc_rs` preserves `EncodingKey::from_rsa_pem` and RS256 while removing the RustCrypto `rsa` edge.

---

## File Map

- Modify: `vite.config.ts` — define named, size-bounded Streamdown and Shiki-core splitting groups with Vite 8/Rolldown APIs.
- Modify: `.mise/tasks/check/frontend-bundle` — create and clean a native temporary directory; remove hash-specific chunk detection; validate the full Markdown asset closure, chunk sizes, names, and async route boundaries.
- Test: `dist/.vite/manifest.json` — generated evidence for route, Markdown, Streamdown, Shiki, grammar, and theme import relationships. Do not edit it.
- Test: `src/components/markdown/-codeHighlighter.test.ts` — preserve the allowlist, aliases, lazy loading, fallback, cache, and coalescing contracts.
- Modify: `scripts/cargo-audit-report.ts` — retain the original JSON parse error as `Error.cause`.
- Modify: `scripts/cargo-audit-report.test.ts` — verify malformed JSON message and cause behavior.
- Modify: `.gitattributes` — set LF only for `src-tauri/src/services/wasm_runtime/cache.rs`.
- Modify: `src-tauri/src/services/wasm_runtime/cache.rs` — normalize EOL only after proving that HEAD, index, and worktree have no semantic difference.
- Modify: the three staged paths reported by Task 4 inventory — apply formatter-only changes. Do not change any additional path unless this plan already names it.
- Modify: `src-tauri/Cargo.toml` — select current `jsonwebtoken` 11 with explicit `use_pem` and `aws_lc_rs` features and no `rust_crypto` feature.
- Modify: `src-tauri/Cargo.lock` — resolve `jsonwebtoken` 11, remove the `rsa` edge, and resolve crates.io `xcb 1.7.1` with `quick-xml 0.41.x`.
- Modify/Test: `src-tauri/src/services/google_service_account.rs` — strengthen the existing `sign_service_account_jwt` and scripted token-exchange tests without changing the production Google flow unless the current API requires a compile-only adjustment.
- Test: `src-tauri/src/windows/screenshot.rs` — preserve the `start_region_screenshot` → `capture_monitor_at` → `xcap::Monitor` behavior; production changes are not expected.

## Seams

- **Seam:** `mise run check:frontend-bundle` — a production build has no Vite/Rolldown warning, no Markdown-related chunk above 500 KiB, no forbidden grammar/package, and no static Markdown runtime in either translation route.
- **Seam:** `.mise/tasks/check/frontend-bundle` CLI on Windows, Linux, and macOS — diagnostics can write, read, and clean temporary files using native paths.
- **Seam:** `parseAuditReport(raw)` — malformed JSON reports a concise message and preserves the original parse error as `cause`.
- **Seam:** `mise run format:check` plus Git blob/EOL comparison — all intended files are formatted, and `cache.rs` changes only from CRLF to LF.
- **Seam:** `sign_service_account_jwt(account, scopes, now)` and `GoogleServiceAccountExchanger::exchange` — PKCS#8 RSA PEM input still produces a verifiable RS256 Google assertion, malformed keys remain non-retryable auth failures, the scripted Google exchange succeeds, and secrets do not enter errors or debug output.
- **Seam:** Cargo’s resolved all-target dependency graph — `rsa 0.9.10` and `quick-xml 0.30.0` are absent; `xcb 1.7.1` reaches `quick-xml 0.41.x` through `xcap`.
- **Seam:** `start_region_screenshot` desktop command — the published `xcb` update preserves monitor selection and capture on supported desktop platforms.
- **Seam:** `mise run audit:cargo` — the known RSA and `quick-xml` advisories are absent with no ignore list, waiver, or suppression.

## Tasks

### Task 1: Split the Markdown Runtime Below the Warning Limit

**Seam:** `mise run check:frontend-bundle`

**Outcome:** The old shared `chunk-BO2N2NFS` asset is replaced by async, named Streamdown and Shiki-core chunks. Every emitted JavaScript chunk is below Vite’s 500 kB warning threshold. The Markdown runtime remains outside both initial translation route closures.

**Files:**

- Modify: `vite.config.ts`
- Modify: `.mise/tasks/check/frontend-bundle`
- Test: `dist/.vite/manifest.json` (generated)
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Run a clean baseline production bundle and retain the log and generated manifest. Confirm the warning identifies a JavaScript chunk above 500 kB. Record the uncompressed byte size of the warned asset from `dist/assets`; do not infer it from gzip size.
- [ ] **Red:** Run `mise run check:frontend-bundle`. Expected failure is the Vite/Rolldown chunk warning or the existing Markdown asset byte check. If it fails earlier because of Windows `mktemp`, run this red check on Linux/macOS and continue to Task 2 before the Windows green check.
- [ ] **Green:** In `vite.config.ts`, add named constants for the split limit and group priorities. Set the group `maxSize` below the warning limit, with 450 KiB as the initial value. Do not change `chunkSizeWarningLimit`.
- [ ] **Green:** Under `build.rolldownOptions.output.codeSplitting.groups`, add a high-priority `streamdown` group matching `node_modules/streamdown/` and a separate `shiki-core` group matching only Shiki runtime/core packages. Exclude `@shikijs/langs` and `@shikijs/themes` so their ten current dynamic entries remain independent.
- [ ] **Green:** In `.mise/tasks/check/frontend-bundle`, replace the hash-specific `chunk-BO2N2NFS` name rule with manifest traversal. Starting from `MarkdownOutput.tsx`, collect its recursive static and dynamic closure, resolve each manifest file, and reject any JavaScript asset above `MAX_MARKDOWN_RELATED_ASSET_BYTES`.
- [ ] **Green:** Add conformance assertions that the generated manifest contains async chunk names beginning with `streamdown` and `shiki-core`; both translation route static closures exclude those chunks; `MarkdownOutput.tsx` remains a dynamic entry; all eight grammar and two theme modules remain dynamic entries; and `@streamdown/code`, `bundledLanguages`, and non-allowlisted grammar IDs remain absent.
- [ ] **Green:** Build again. Compare the largest new Markdown runtime part with the recorded baseline. Require the old warned asset to disappear and every replacement part to be both smaller than the baseline and no larger than 500 KiB.
- [ ] If either named group still exceeds 500 KiB, lower that group’s `maxSize` in measured increments and rebuild. Do not alter lazy highlighter behavior or add broad vendor groups.

**Validation:**

- Run (red): `mise run check:frontend-bundle`
- Expected: nonzero exit caused by the current >500 kB bundle diagnostic or existing Markdown size assertion.
- Run (green): `mise run check:frontend-bundle`
- Expected: exit 0; no Vite/Rolldown warning; named async Streamdown and Shiki-core chunks exist; no JavaScript chunk exceeds 500 KiB; route and allowlist assertions pass.
- Run: `bun test src/components/markdown/-codeHighlighter.test.ts`
- Expected: all highlighter contract tests pass with eight grammars and two themes still lazy.
- Run: `mise run typecheck`
- Expected: exit 0.

### Task 2: Make Bundle Diagnostics Temporary Storage Cross-Platform

**Seam:** `.mise/tasks/check/frontend-bundle` CLI on Windows, Linux, and macOS

**Outcome:** The bundle task creates one writable OS temporary directory through Bun, uses slash-normalized native absolute paths for the log and inspector, and always removes the directory.

**Files:**

- Modify: `.mise/tasks/check/frontend-bundle`

**Steps:**

- [ ] **Red:** On Windows, run `mise run check:frontend-bundle` with the current script and capture the `ENOENT` caused by Bun reading a POSIX-style `mktemp` path. Confirm Linux/macOS still reach bundle diagnostics.
- [ ] **Green:** Replace both `mktemp` calls with one `bun -e` invocation that imports `mkdtempSync`, `tmpdir`, and `join`, creates `langnext-frontend-bundle-*` under the OS temporary directory, and prints the absolute path with backslashes converted to forward slashes for Bash interoperability.
- [ ] **Green:** Set `build_log="$temp_dir/build.log"` and `inspector="$temp_dir/inspector.mjs"`.
- [ ] **Green:** Change cleanup to `rm -rf -- "$temp_dir"` and keep `trap cleanup EXIT`. Do not leave separate temp files or put diagnostics under the repository.
- [ ] **Green:** Before the build, verify the directory exists and create a small probe file through Bun. Remove the probe before running the build. Fail with a direct temp-directory error if this check fails.
- [ ] **Green:** Preserve the existing `PIPESTATUS`, build log, diagnostics, manifest, and inspector control flow.

**Validation:**

- Run (red, Windows): `mise run check:frontend-bundle`
- Expected: current script fails with `ENOENT` at the Bun/native-path boundary.
- Run (green, Windows): `mise run check:frontend-bundle`
- Expected: exit 0; Bun reads the build log and inspector; the temp directory is absent after exit.
- Run (green, Linux): `mise run check:frontend-bundle`
- Expected: exit 0 and no residual `langnext-frontend-bundle-*` directory.
- Run (green, macOS): `mise run check:frontend-bundle`
- Expected: exit 0 and no residual `langnext-frontend-bundle-*` directory.
- Run failure-path check on each host by temporarily forcing the inspector to exit nonzero in the working copy, then restore that line without retaining the edit.
- Expected: the task exits nonzero and still removes the temp directory.

### Task 3: Preserve Cargo Audit Parse Causes

**Seam:** `parseAuditReport(raw)`

**Outcome:** Malformed cargo-audit JSON keeps the existing concise message and exposes the original parser exception through `Error.cause`; lint passes.

**Files:**

- Modify: `scripts/cargo-audit-report.test.ts`
- Modify: `scripts/cargo-audit-report.ts`

**Steps:**

- [ ] **Red:** Extend the existing malformed-report test. Catch the error from `parseAuditReport("{")`, assert it is an `Error`, assert its message contains `malformed cargo-audit JSON`, and assert `cause` is the original `SyntaxError`.
- [ ] **Red:** Run the targeted test. Expected failure is an absent `cause`.
- [ ] **Green:** Change only the JSON parse catch to construct `new Error(message, { cause: error })` with the existing message expression and formatting.
- [ ] **Green:** Do not expose raw audit JSON or advisory descriptions in the error.

**Validation:**

- Run (red): `bun test scripts/cargo-audit-report.test.ts`
- Expected: the new cause assertion fails.
- Run (green): `bun test scripts/cargo-audit-report.test.ts`
- Expected: all reporter tests pass.
- Run: `mise run lint`
- Expected: ESLint and oxlint exit 0; the caught-error lint finding is absent.

### Task 4: Resolve Formatting and the `cache.rs` EOL Baseline

**Seam:** `mise run format:check` plus Git blob/EOL comparison

**Outcome:** The exact three staged formatting paths are formatted, every plan-owned file is formatted, and `cache.rs` has an explicit LF policy with no semantic change.

**Files:**

- Modify: `.gitattributes`
- Modify: `src-tauri/src/services/wasm_runtime/cache.rs` (EOL only)
- Modify: the exact three staged paths discovered in the first step
- Modify: other plan-owned files only when their project formatter requires it

**Steps:**

- [ ] **Red:** Inventory repository state before formatting:
  - `git status --short`
  - `git diff --cached --name-only --diff-filter=ACMR`
  - `git diff --name-only --diff-filter=ACMR`
  - `git ls-files --eol -- src-tauri/src/services/wasm_runtime/cache.rs`
- [ ] Record the exact three staged formatting paths. If the staged list is not exactly the expected three paths, stop this task and report the additional paths. Do not format or restore an unknown path.
- [ ] **Red:** Run `mise run format:check` and map each formatter failure to one of the inventoried paths or a file changed by Tasks 1-3. Expected: nonzero exit with the known staged formatting failures.
- [ ] Compare `cache.rs` across all three states:
  - `git diff --ignore-space-at-eol HEAD -- src-tauri/src/services/wasm_runtime/cache.rs`
  - `git diff --cached --ignore-space-at-eol -- src-tauri/src/services/wasm_runtime/cache.rs`
  - `git diff --word-diff=porcelain HEAD -- src-tauri/src/services/wasm_runtime/cache.rs`
- [ ] If any command shows a semantic token change, stop and treat it as an external baseline blocker. Do not normalize or edit cache behavior in this plan.
- [ ] **Green:** Add the single path rule `src-tauri/src/services/wasm_runtime/cache.rs text eol=lf` to `.gitattributes`. Do not add a repository-wide EOL rule.
- [ ] **Green:** Rewrite only CRLF sequences in `cache.rs` to LF with a byte-preserving Bun script. Assert the normalized text content equals the pre-change content after both are normalized to LF.
- [ ] **Green:** Run the applicable project formatter on the three inventoried files and all files changed by this plan. Retain only formatter changes in those paths. Do not stage, restore, or rewrite unrelated paths.
- [ ] Re-run the three Git comparison commands. Require `cache.rs` to show only EOL normalization and `git ls-files --eol` to report LF in the worktree.

**Validation:**

- Run (red): `mise run format:check`
- Expected: nonzero exit naming the known formatting paths.
- Run (green): `mise run format:check`
- Expected: oxfmt and cargo fmt both exit 0.
- Run: `cargo test --manifest-path src-tauri/Cargo.toml services::wasm_runtime::cache::tests`
- Expected: all cache identity, LRU, and disposal tests pass unchanged.
- Run: `git diff --ignore-space-at-eol HEAD -- src-tauri/src/services/wasm_runtime/cache.rs`
- Expected: no semantic diff.

### Task 5: Move Google RS256 Signing to `aws_lc_rs`

**Seam:** `sign_service_account_jwt(account, scopes, now)` and `GoogleServiceAccountExchanger::exchange`

**Outcome:** Google service-account assertions still use PKCS#8 PEM and RS256, but Cargo no longer resolves the unpatched RustCrypto `rsa` crate.

**Files:**

- Modify: `src-tauri/src/services/google_service_account.rs` tests
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Steps:**

- [ ] **Red:** Add a dependency-closure check that exits nonzero while any `rsa` package is present:
  ```bash
  if cargo tree --manifest-path src-tauri/Cargo.toml --target all -i rsa >/dev/null 2>&1; then
    echo "error: RustCrypto rsa remains in the all-target graph" >&2
    exit 1
  fi
  ```
- [ ] **Red:** Run the check. Expected failure: `jsonwebtoken 10.4.0 -> rsa 0.9.10` is still resolved.
- [ ] Before changing dependencies, strengthen the existing JWT test through the public signing function:
  - Sign with the fixed PKCS#8 test private key.
  - Decode the header and require `alg = RS256`.
  - Verify the signature with a fixed matching RSA public key.
  - Decode claims and require the exact issuer, space-joined scope, pinned Google audience, `iat`, and one-hour `exp`.
  - Keep malformed-key and no-secret/JWT-in-debug assertions.
- [ ] Keep the existing scripted `TokenGrantService::acquire` success test. Require an assertion form body, `DestinationPolicy::TrustedFixed`, credential revision propagation, and no access-token leakage.
- [ ] **Green:** In `src-tauri/Cargo.toml`, replace the current declaration with `jsonwebtoken = { version = "11.0.0", default-features = false, features = ["use_pem", "aws_lc_rs"] }`. Do not enable `rust_crypto`.
- [ ] **Green:** Update `src-tauri/Cargo.lock` through Cargo. Do not edit lock entries manually.
- [ ] **Green:** Keep `EncodingKey::from_rsa_pem`, `Header::new(Algorithm::RS256)`, and `encode` unless the compiler requires a direct current-API adjustment. Do not implement RSA signing directly.
- [ ] **Green:** Run the dependency-closure check again and inspect `cargo tree --target all -i jsonwebtoken` to confirm only the AWS-LC backend is enabled.

**Validation:**

- Run (red): the `cargo tree ... -i rsa` guard above.
- Expected: exit 1 because `rsa 0.9.10` exists.
- Run (green): the same guard.
- Expected: exit 0 because no `rsa` package exists in the all-target graph.
- Run: `cargo test --manifest-path src-tauri/Cargo.toml google_service_account`
- Expected: PKCS#8 parsing, RS256 header/signature/claims, malformed-key mapping, scripted exchange, and leakage tests pass.
- Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
- Expected: exit 0 on Windows, Linux, and macOS hosts.

### Task 6: Resolve the `xcap` `quick-xml` Advisories with Published `xcb`

**Seam:** Cargo’s all-target dependency graph and `start_region_screenshot`

**Outcome:** `xcap` resolves crates.io `xcb 1.7.1`, which uses `quick-xml 0.41.x`; `quick-xml 0.30.0` is absent without a Git source or patch.

**Files:**

- Modify: `src-tauri/Cargo.lock`
- Test: `src-tauri/src/windows/screenshot.rs`

**Steps:**

- [ ] **Red:** Add and run a dependency-closure guard that exits nonzero while the vulnerable package is present:
  ```bash
  if cargo tree --manifest-path src-tauri/Cargo.toml --target all -i quick-xml@0.30.0 >/dev/null 2>&1; then
    echo "error: vulnerable quick-xml 0.30.0 remains in the all-target graph" >&2
    exit 1
  fi
  ```
- [ ] **Red:** Expected failure: `xcap -> xcb 1.7.0 -> quick-xml 0.30.0` remains resolved.
- [ ] **Green:** Run `cargo update --manifest-path src-tauri/Cargo.toml -p xcb --precise 1.7.1`. Let Cargo update `quick-xml` to the compatible 0.41.x release. Do not add `[patch.crates-io]`, a Git URL, or an advisory ignore.
- [ ] **Green:** Inspect `src-tauri/Cargo.lock` and `cargo tree --target all -i xcb@1.7.1`. Require the source to be crates.io, require the parent path through `xcap`, and require `quick-xml >=0.41.0`.
- [ ] **Green:** Run the vulnerable-package guard again. Also search the lockfile for `quick-xml 0.30.0` and the old `xcb 1.7.0`; both must be absent.
- [ ] **Green:** Compile and test the existing screenshot module without production refactoring. On each desktop host, run a manual region-screenshot smoke check: invoke the normal UI command, select a nonempty region, confirm valid dimensions and PNG output, verify clipboard behavior, and cancel a second capture without leaving the overlay or hidden windows active.

**Validation:**

- Run (red): the `quick-xml@0.30.0` guard above.
- Expected: exit 1.
- Run (green): the same guard.
- Expected: exit 0.
- Run: `cargo tree --manifest-path src-tauri/Cargo.toml --target all -i xcb@1.7.1`
- Expected: one crates.io path through `xcap`; no Git source.
- Run: `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
- Expected: exit 0 on Windows, Linux, and macOS.
- Run: `mise run tauri:build`
- Expected: desktop package build succeeds on each packaging host.
- Run: the manual screenshot smoke check on Windows, Linux, and macOS.
- Expected: monitor capture, crop, PNG result, clipboard, cancellation, and window restoration behave as before.

### Task 7: Prove the Security Gate Is Clean

**Seam:** `mise run audit:cargo`

**Outcome:** Cargo audit exits 0. The known `quick-xml` and RSA advisories are removed by dependency resolution, not hidden.

**Files:**

- Test: `.mise/tasks/audit/cargo`
- Test: `.audit/cargo-audit.json` (generated, do not commit)
- Test: `src-tauri/Cargo.lock`

**Steps:**

- [ ] **Red:** Before Tasks 5-6, run `mise run audit:cargo` and retain `.audit/cargo-audit.json`. Confirm it includes `RUSTSEC-2026-0194`, `RUSTSEC-2026-0195`, and `RUSTSEC-2023-0071` with the supplied dependency paths.
- [ ] **Green:** After Tasks 5-6, run the same task without changing `.mise/tasks/audit/cargo` to ignore packages or advisories.
- [ ] **Green:** Require exit 0 and require the generated report to omit all three advisory IDs. Confirm `cargo tree --target all -i rsa` and `cargo tree --target all -i quick-xml@0.30.0` find no packages.
- [ ] If a new advisory appears, do not waive it. Map it to its exact lockfile path and use a maintained patched release or safe feature/backend change. If no patched compatible release or safe refactor exists, stop with the advisory ID, affected version, dependency path, upstream issue/release status, and the exact blocked validation command.

**Validation:**

- Run (red): `mise run audit:cargo`
- Expected: nonzero exit with the three known advisory rows.
- Run (green): `mise run audit:cargo`
- Expected: exit 0 with no vulnerability rows and no suppression configuration.

## Final Validation

Run in this order from the repository root after all task-level red/green cycles pass:

1. `bun test`
   - Expected: all frontend and script tests pass, including highlighter and cargo-audit reporter contracts.
2. `mise run lint`
   - Expected: ESLint and oxlint exit 0.
3. `mise run typecheck`
   - Expected: TypeScript 7 exits 0.
4. `mise run format:check`
   - Expected: oxfmt and cargo fmt exit 0.
5. `mise run check:frontend-bundle`
   - Expected: production build exits 0 on Windows, Linux, and macOS; no warning; every JavaScript chunk is below 500 KiB; Markdown runtime and Shiki assets remain async and allowlisted.
6. `mise run build`
   - Expected: frontend typecheck and production build exit 0.
7. `cargo test --manifest-path src-tauri/Cargo.toml`
   - Expected: the full Rust test suite passes.
8. `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`
   - Expected: all Rust targets for the current host compile. Run on Windows, Linux, and macOS.
9. `mise run audit:cargo`
   - Expected: exit 0; no known vulnerability rows.
10. `mise run tauri:build`
    - Expected: installers and portable artifacts build on each packaging host.
11. Review `git status --short`, `git diff --stat`, `git diff --check`, and `git diff`.
    - Expected: only plan-scoped files changed; no generated audit/temp files are included; `cache.rs` is EOL-only; no lockfile Git source was added for `xcb`; no warning threshold or audit suppression changed.

## Failure Behavior

- A bundle part remains above 500 KiB — keep the gate failing, reduce the matching group `maxSize`, and rebuild. Do not increase Vite’s warning limit.
- A route statically reaches Markdown, Streamdown, or Shiki core — keep the gate failing and correct the group/import graph. Do not relax the closure assertion.
- A grammar or theme collapses into a core group — narrow the Shiki-core regex until the ten allowlisted modules are independent dynamic entries again.
- Temporary directory creation or cleanup fails — print the absolute path and operation, exit nonzero, and preserve no fallback to POSIX `mktemp`.
- Cargo-audit JSON is malformed — report the concise message with the original parse error as `cause`; do not print raw report content.
- AWS-LC rejects a PEM key — return the existing non-retryable `CapabilityErrorCode::Auth` message without the key or JWT.
- Google token exchange fails — preserve current status classification, pinned destination policy, cancellation, and no-body/no-token leakage.
- Cargo cannot resolve crates.io `xcb 1.7.1` — stop. Report the registry error and current dependency graph. Do not substitute a branch-based Git dependency without explicit approval.
- A semantic `cache.rs` diff exists — stop EOL normalization and report the HEAD/index/worktree hunks as a baseline blocker.
- A new Rust advisory remains — stop the security gate with the exact advisory and dependency path. Do not waive or suppress it.

## Privacy and Security

- Never log or snapshot the service-account private key, signed JWT, OAuth assertion form value, or access token.
- Use only the fixed test RSA key and matching public key in tests. Mark them as non-secret fixtures.
- Keep the Google OAuth audience and destination pinned to `https://oauth2.googleapis.com/token`.
- Select exactly one `jsonwebtoken` crypto backend. Explicitly disable default features, then enable only `use_pem` and `aws_lc_rs`.
- Do not add cargo-audit ignore flags, advisory allowlists, or package exclusions.
- Do not add a moving Git branch or unpinned revision to the Rust dependency graph.
- Keep bundle temp content in the OS temp directory and remove it on success, test failure, build failure, and signal-driven shell exit where `EXIT` runs.

## Rollout Notes

- Land the frontend/tooling slices before the Rust dependency slices so each gate has a focused diff and validation record.
- Run the cross-platform bundle task and Rust compile/package matrix before merge. A single Windows-only success does not cover `xcap`’s Linux/macOS paths.
- Record before/after uncompressed chunk sizes and the final Cargo dependency paths in the PR description. Do not commit `dist/` or `.audit/` unless repository policy already tracks a specific generated file.
- Keep `src/routeTree.gen.ts` untouched unless the normal build regenerates it because of an actual route change; this plan has no route change.

## Risks and Mitigations

- **Rolldown group rules can pull lazy modules into a shared chunk.** — Use package-specific tests, priorities, and `maxSize`; assert both route static closures and all ten grammar/theme dynamic entries in the manifest.
- **A Shiki regex can accidentally include grammars/themes.** — Exclude `@shikijs/langs` and `@shikijs/themes` explicitly and keep their manifest assertions.
- **Bash and native Windows tools interpret paths differently.** — Create paths with Bun, print slash-normalized absolute paths, and validate the same task on all three desktop operating systems.
- **`jsonwebtoken` 11 is a major update.** — Keep the production API surface unchanged, strengthen RS256 verification before the dependency change, and run the full Rust suite and platform build matrix.
- **AWS-LC adds native build complexity.** — The lockfile already contains AWS-LC through Rustls, but feature unification can still change builds. Validate all desktop hosts and release packaging.
- **`xcb 1.7.1` changes Linux build-time XML generation.** — Use the published crates.io release, inspect the lock source, compile on Linux, and run a real screenshot smoke check.
- **Formatting can hide unrelated edits.** — Inventory staged and unstaged paths first, format only named paths, and use semantic EOL comparisons for `cache.rs`.

## Open Questions

- The exact three staged formatting paths remain unknown until Task 4 runs the Git inventory. This does not change the implementation approach, but any unexpected fourth path is a stop condition.
- The exact baseline byte size of `chunk-BO2N2NFS` must be measured by the Task 1 clean build. Acceptance does not depend on a guessed value: the old warned chunk must disappear, every replacement must be smaller, and every JavaScript chunk must be at or below 500 KiB.
- If platform CI lacks a physical desktop session, the screenshot smoke check remains blocked on that host. Report the host and missing session capability; do not replace it with fake capture data.
