# Implementation Plan

**Goal:** Make JavaScript and Rust dependency audits reproducible, remediate every known vulnerability with the smallest compatible update, and block release when an advisory is unresolved without a precise upstream exception.

**Inputs:** The supplied audit limitations and remediation requirements; `package.json`; `bun.lock`; `src-tauri/Cargo.toml`; `src-tauri/Cargo.lock`; `mise.toml`; `.mise/tasks/*`; `.gitignore`; mise cargo-backend documentation from `/jdx/mise`; crates.io metadata for `cargo-audit@0.22.2`.

**Assumptions:**

- The Markdown language-bundle plan runs first because it intentionally changes `package.json` and `bun.lock`.
- Network access to the Bun registry, crates.io, and the RustSec advisory database is available during execution.
- `cargo-audit@0.22.2` is the selected project tool. Its declared minimum Rust version is below the project's Rust `1.96.1`.
- The actual advisory IDs, dependency paths, and patched versions are unknown until the audit tasks run. The plan does not invent them.
- The user declined the seam confirmation prompt. The seams below are therefore plan assumptions.

**Architecture:** mise will pin `cargo-audit` through the `cargo:` backend and expose Bun and Cargo audit file tasks. Audit reports will go to an ignored `.audit/` workspace. Remediation will proceed one advisory root at a time: capture the path, choose the smallest current compatible patched release, update with Bun or Cargo only, run the affected public test seam, and rerun the audit. An unpatched upstream advisory remains a release blocker unless the final report records its exact external evidence and the user accepts the blocker.

**Tech Stack:** Bun 1.3, Bun lockfile and audit, Cargo, RustSec `cargo-audit@0.22.2`, mise file tasks, Rust 1.96.1.

---

## Requirement Map

| Finding or requirement                                 | Plan coverage                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The reported 18 JavaScript advisories were not mapped  | Task 2 captures IDs, paths, versions, and root ownership before updates.                            |
| Update direct and transitive JavaScript dependencies   | Tasks 3–4 use one direct root or transitive package per vertical slice.                             |
| Use Bun only; avoid unrelated major migrations         | Tasks 3–4 prohibit npm/Yarn/pnpm and define version-selection rules.                                |
| `cargo-audit` was unavailable and not declared         | Task 1 pins `cargo:cargo-audit = "0.22.2"` in mise and adds a task.                                 |
| Do not rely on a global binary                         | Task 1 invokes the mise-managed tool.                                                               |
| Generated tool artifacts must stay ignored             | Task 1 adds `/.audit/`; mise's tool installation remains outside the repository.                    |
| Run Cargo audit against `src-tauri/Cargo.lock`         | Tasks 1 and 5 use the explicit lockfile path.                                                       |
| Zero known vulnerabilities or precise upstream blocker | Tasks 4–6 define the exit and evidence policy.                                                      |
| No blanket latest update                               | Explicitly prohibited in Tasks 3–5.                                                                 |
| Full tests, build, and conformance                     | Final Validation includes frontend, Rust, conformance-filter, build, lint, format, and both audits. |

## File Map

- Create: `.mise/tasks/audit/bun` — save Bun audit JSON and dependency tree under `.audit/`, then return the audit status.
- Create: `.mise/tasks/audit/cargo` — run the mise-managed Cargo auditor against `src-tauri/Cargo.lock` and save machine-readable output under `.audit/`.
- Create: `.mise/tasks/audit/all` — run both audit tasks and preserve either failure.
- Modify: `mise.toml` — pin `cargo:cargo-audit = "0.22.2"`.
- Modify: `.gitignore` — ignore only the repository-root `/.audit/` directory.
- Modify: `package.json` — update only direct packages required to remove audited JavaScript paths.
- Modify: `bun.lock` — Bun-generated compatible direct and transitive resolutions.
- Modify: `src-tauri/Cargo.toml` — update only direct crate constraints required by RustSec findings.
- Modify: `src-tauri/Cargo.lock` — Cargo-generated compatible direct and transitive resolutions.
- Runtime artifact: `.audit/bun-audit.before.json` — ignored baseline Bun advisory report.
- Runtime artifact: `.audit/bun-dependency-tree.before.txt` — ignored baseline Bun dependency graph.
- Runtime artifact: `.audit/cargo-audit.before.json` — ignored baseline RustSec report.
- Runtime artifact: `.audit/advisory-remediation.md` — ignored working table with one row per advisory.

Every new task file must start with the repository-required two-line `ABOUTME:` header.

## Seams

- **Seam:** `mise run audit:bun` — verifies the resolved `bun.lock` graph and exits non-zero for known JavaScript vulnerabilities.
- **Seam:** `mise run audit:cargo` — verifies `src-tauri/Cargo.lock` with the pinned project auditor and exits non-zero for RustSec vulnerabilities.
- **Seam:** `mise run audit:all` — provides one release-gate result without hiding either ecosystem's failure.
- **Seam:** The affected package's existing public application or tool interface — verifies that each targeted dependency update preserves behavior.
- **Seam:** `bun install --frozen-lockfile` and `cargo ... --locked` — verify reproducible lockfiles after remediation.

## Tasks

### Task 1: Add reproducible audit entry points

**Seam:** `mise run audit:bun`, `mise run audit:cargo`, and `mise run audit:all`.

**Outcome:** Any contributor can run the same auditors without a global `cargo-audit`, and generated reports cannot be committed accidentally.

**Files:**

- Create: `.mise/tasks/audit/bun`
- Create: `.mise/tasks/audit/cargo`
- Create: `.mise/tasks/audit/all`
- Modify: `mise.toml`
- Modify: `.gitignore`

**Steps:**

- [ ] **Red:** Run `mise run audit:cargo`. Confirm mise reports that the task does not exist.
- [ ] **Red:** Run `mise exec -- cargo-audit --version`. Confirm the project config does not provide the binary.
- [ ] **Green:** Add `"cargo:cargo-audit" = "0.22.2"` to `[tools]` in `mise.toml`. Do not use `latest`.
- [ ] **Green:** Add `/.audit/` to `.gitignore`. Do not add `.tools/` because the mise cargo backend does not install this tool in the repository.
- [ ] **Green:** Implement `audit:bun` to create `.audit/`, run `bun audit --json` to `.audit/bun-audit.json`, run `bun pm ls --all` to `.audit/bun-dependency-tree.txt`, and preserve the audit exit code.
- [ ] **Green:** Implement `audit:cargo` to create `.audit/`, run `cargo audit --file src-tauri/Cargo.lock --json` to `.audit/cargo-audit.json`, and preserve the audit exit code. Invoke `cargo audit` through the mise environment, not an absolute or global path.
- [ ] **Green:** Implement `audit:all` so both ecosystem audits run even if the first fails and the task exits non-zero if either fails.
- [ ] Confirm `git status --short --ignored .audit` marks reports as ignored.

**Validation:**

- Run (red): `mise run audit:cargo`
- Expected: mise reports an unknown task.
- Run (green/tooling): `mise install && mise exec -- cargo-audit --version`
- Expected: Output is `cargo-audit 0.22.2` from the project environment.
- Run (green/interface): `mise run audit:all`
- Expected: Both report files are created. The task may still exit non-zero because vulnerability remediation has not started; it must not fail due to a missing tool or wrong lockfile path.

### Task 2: Establish the advisory ledger

**Seam:** Audit JSON plus the resolved dependency graphs.

**Outcome:** Every Bun and RustSec finding has an owner path, current version, patched target or explicit no-patch status, and validation scope before any package update.

**Files:**

- Runtime artifact: `.audit/bun-audit.before.json`
- Runtime artifact: `.audit/bun-dependency-tree.before.txt`
- Runtime artifact: `.audit/cargo-audit.before.json`
- Runtime artifact: `.audit/advisory-remediation.md`

**Steps:**

- [ ] **Red:** Copy the first generated reports to the `.before` names and create one ledger row per advisory with columns: ecosystem, advisory ID/URL, vulnerable package, direct/transitive, current version, patched range, root dependency path, chosen target, breaking risk, lockfile delta, affected seam, status, external blocker.
- [ ] Fail the ledger check if the row count differs from the unique advisory count. Do not assume the supplied count of 18 is still current; record any change in the live audit result.
- [ ] For Bun, classify a package as direct only when it appears in `package.json`; derive every transitive root from `bun pm ls --all` and `bun.lock`.
- [ ] For Cargo, classify direct packages from the applicable dependency section in `src-tauri/Cargo.toml`; derive transitive roots from `cargo tree -i <crate>@<version> --manifest-path src-tauri/Cargo.toml --locked`.
- [ ] Record the lowest patched version allowed by the current direct-root constraint and the newest compatible release in the same major line. Choose the newest compatible patched release unless its changelog or peer constraints show a material incompatibility.
- [ ] Mark a major update as `required-major` only when no patched compatible release can remove the advisory. Stop that row for user approval; do not mix the migration into this remediation.
- [ ] Mark `upstream-unpatched` only when the advisory and package registry show no patched release and no compatible parent release removes the path. Record exact URLs and dependency paths.
- [ ] **Green:** Complete the ledger before changing either lockfile.

**Validation:**

- Run (red): `mise run audit:all`
- Expected: The baseline remains non-zero when live findings exist.
- Run (green/ledger): Compare unique advisory IDs in both JSON reports with `.audit/advisory-remediation.md`.
- Expected: Every unique advisory has one row and every row has a root path and chosen disposition.

### Task 3: Remediate each vulnerable direct JavaScript package

**Seam:** `mise run audit:bun` plus the affected package's public application/tool interface.

**Outcome:** Each vulnerable direct package moves to a current compatible patched release in an isolated lockfile delta.

**Files:**

- Modify as required: `package.json`
- Modify: `bun.lock`
- Test existing or create a focused `src/**/-*.test.ts(x)` file only when the affected public seam lacks coverage
- Update runtime artifact: `.audit/advisory-remediation.md`

**Steps:**

- [ ] Process one direct package/root at a time. Do not run `bun update --latest` or update unrelated packages.
- [ ] **Red:** Run `mise run audit:bun` and confirm the package's advisory ID is present.
- [ ] **Red:** Run the existing targeted test for the public seam selected in the ledger. If no test exists, add one behavioral test first and confirm it fails only when the patched API expectation differs; do not mock package internals.
- [ ] Review the patched release changelog, peer constraints, and engine range. Keep the current major unless the ledger marks `required-major` and the user approves it.
- [ ] **Green:** Run `bun update <direct-package>@<chosen-compatible-version>` with the exact selected version. Use Bun only.
- [ ] Inspect `package.json` and `bun.lock`. Revert unrelated resolution movement before continuing.
- [ ] Run `bun install --frozen-lockfile`, the targeted test, `mise run typecheck`, and the relevant build/lint seam.
- [ ] Rerun `mise run audit:bun`. Mark only advisories removed by this slice as resolved and record the lockfile delta.
- [ ] Repeat the red-green cycle for the next direct package.

**Validation:**

- Run (red, each slice): `mise run audit:bun`
- Expected: The selected advisory ID is present before its update.
- Run (green, each slice): `bun install --frozen-lockfile && bun test <targeted-test-path> && mise run typecheck && mise run audit:bun`
- Expected: The selected advisory disappears; targeted behavior and typecheck pass. The audit can remain non-zero only for ledger rows not processed yet.

### Task 4: Remediate each vulnerable transitive JavaScript package

**Seam:** `mise run audit:bun` plus the owning direct root's public application/tool interface.

**Outcome:** Every patchable transitive advisory is removed without an unrelated direct-major migration.

**Files:**

- Modify as required: `package.json`
- Modify: `bun.lock`
- Test existing or create a focused test at the owning direct root's public seam
- Update runtime artifact: `.audit/advisory-remediation.md`

**Steps:**

- [ ] Process one transitive package/root path at a time.
- [ ] **Red:** Confirm the exact advisory and root path in `mise run audit:bun` and `bun pm ls --all`.
- [ ] First update the owning direct root to the chosen compatible patched release with `bun update <root>@<version>`.
- [ ] If the vulnerable package remains and its parent allows a patched version, use a targeted Bun update for that package. Do not add a direct dependency solely to force resolution unless Bun cannot express the compatible transitive update and the ledger documents why.
- [ ] Do not use a resolution override for an API-incompatible version. Treat that case as `required-major` or `upstream-unpatched`.
- [ ] **Green:** Run the owning root's targeted public-seam tests, frozen install, typecheck, lint/build as applicable, and `mise run audit:bun`.
- [ ] Record all duplicate paths for the advisory. The row is resolved only when no vulnerable path remains.

**Validation:**

- Run (red, each slice): `mise run audit:bun`
- Expected: The selected transitive advisory and root path are present.
- Run (green, each slice): `bun install --frozen-lockfile && bun test <owning-seam-test-path> && mise run typecheck && mise run audit:bun`
- Expected: No vulnerable path remains for the selected advisory. Other unprocessed rows can still keep the audit non-zero.

### Task 5: Remediate each RustSec finding

**Seam:** `mise run audit:cargo` plus the affected Rust service or binary's public test seam.

**Outcome:** `src-tauri/Cargo.lock` contains compatible patched crates, or each unpatchable finding has precise upstream evidence.

**Files:**

- Modify as required: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Test existing or create a focused Rust test in the owning module when public behavior lacks coverage
- Update runtime artifact: `.audit/advisory-remediation.md`

**Steps:**

- [ ] Process one RustSec advisory/root at a time.
- [ ] **Red:** Run `mise run audit:cargo`; confirm the advisory ID and vulnerable crate version.
- [ ] Resolve inverse paths with `cargo tree -i <crate>@<version> --manifest-path src-tauri/Cargo.toml --locked`.
- [ ] For a direct crate, select a patched release compatible with the current declared major and update the manifest constraint only if required. For a transitive crate, update the owning direct crate first when a compatible parent release exists.
- [ ] **Green:** Use `cargo update -p <crate>@<current-version> --precise <patched-version> --manifest-path src-tauri/Cargo.toml` for the selected lockfile movement. Do not hand-edit `Cargo.lock`.
- [ ] Run the affected module's test filter, `cargo check --manifest-path src-tauri/Cargo.toml --locked`, and `mise run audit:cargo`.
- [ ] If the only fix requires a direct major migration, stop and request approval with the affected API surface and migration estimate.
- [ ] If no patch exists, record the RustSec URL, affected versions, full inverse dependency path, upstream issue/release evidence, exposure analysis, and why removal is not currently possible. Do not add an ignore flag.

**Validation:**

- Run (red, each slice): `mise run audit:cargo`
- Expected: The selected RustSec advisory is present.
- Run (green, each slice): `cargo check --manifest-path src-tauri/Cargo.toml --locked && mise run test <affected-filter> && mise run audit:cargo`
- Expected: The selected advisory disappears and the affected test seam passes. Other unprocessed advisories can still keep the audit non-zero.

### Task 6: Close the security gate

**Seam:** `mise run audit:all`.

**Outcome:** Both audits pass with zero known vulnerabilities, or the work stops with a complete external-blocker report and no suppression.

**Files:**

- Update runtime artifact: `.audit/advisory-remediation.md`
- Modify tracked files only when a final targeted dependency correction is required

**Steps:**

- [ ] **Red:** Run `mise run audit:all` before final closure. Confirm any remaining finding maps to an unresolved ledger row.
- [ ] Resolve every patchable row through Tasks 3–5.
- [ ] **Green:** Run `mise run audit:all` and require exit code zero.
- [ ] If exit code cannot be zero because an upstream patch does not exist, stop. Report the exact advisory, package/crate, locked version, dependency paths, upstream evidence, runtime exposure, and available alternatives. Do not add Bun ignore configuration, Cargo audit ignore flags, warning filters, or blanket allowlists.
- [ ] Keep `.audit/` ignored. Copy only the concise final blocker evidence into the PR/work item when needed; do not commit generated audit databases or raw dependency trees.

**Validation:**

- Run (red): `mise run audit:all`
- Expected: Non-zero while any patchable row remains.
- Run (green): `mise run audit:all`
- Expected: Exit code zero and both reports contain zero vulnerabilities.
- Blocked alternative: non-zero is acceptable only as an explicit delivery blocker, not as completion.

## Targeted Test Selection

Use the ledger to select an exact public seam:

| Changed root                                | Minimum targeted validation                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| React, Streamdown, Shiki, Tailwind, Base UI | Closest `bun test src/**/<feature>.test.ts(x)`, then `mise run typecheck` and `mise run build`                                   |
| TanStack Router/plugin                      | Route tests, `mise run typecheck`, generated route-tree check through `mise run build`                                           |
| TanStack Query or Effect                    | Owning query/workflow tests, then `mise run typecheck` and `mise run build`                                                      |
| Tauri JavaScript API/plugin                 | Owning storage/feature test, `mise run typecheck`, `mise run build`, and a focused Tauri smoke test when native behavior changed |
| ESLint/oxlint/oxfmt/TypeScript/Vite tooling | `mise run lint`, `mise run format:check`, `mise run typecheck`, and `mise run build` as applicable                               |
| Rust runtime/service crate                  | `mise run test <owning-module-filter>` and `cargo check --manifest-path src-tauri/Cargo.toml --locked`                           |
| Rust conformance/runtime-plugin crate       | `mise run test conformance` plus the owning module filter                                                                        |

## Final Validation

Run in order after all patchable rows are resolved:

1. `bun install --frozen-lockfile`
   - Expected: Success with no `bun.lock` change.
2. `mise run audit:bun`
   - Expected: Zero known JavaScript vulnerabilities.
3. `mise run typecheck`
   - Expected: No TypeScript error.
4. `bun test`
   - Expected: Complete Bun test suite passes.
5. `mise run lint`
   - Expected: ESLint and oxlint pass.
6. `mise run build`
   - Expected: Frontend production build succeeds with zero Vite/Rolldown warnings.
7. `cargo check --manifest-path src-tauri/Cargo.toml --locked`
   - Expected: Rust check succeeds without lockfile changes.
8. `mise run test conformance`
   - Expected: All tests matching the repository's conformance filter pass. Confirm the command reports at least one executed test; if it reports zero, identify and run the exact conformance test target before continuing.
9. `mise run test`
   - Expected: Complete Rust test suite passes.
10. `mise run audit:cargo`
    - Expected: Zero RustSec vulnerabilities.
11. `mise run format:check`
    - Expected: oxfmt and rustfmt report no change.
12. `mise run audit:all`
    - Expected: Aggregate security gate exits zero.

If the frontend bundle plan is in the same delivery, also run `mise run check:frontend-bundle` and require its zero-warning and language-asset checks to pass.

## Failure Behavior

- Auditor download or registry outage — task exits non-zero and reports an infrastructure blocker. It does not reuse a stale success result.
- Malformed or incomplete audit JSON — stop remediation and preserve the raw report; do not infer advisory mappings.
- No compatible patched release — classify as `required-major` or `upstream-unpatched`, provide exact evidence, and stop for a decision.
- Update changes unrelated packages — revert the slice and use a narrower Bun/Cargo command.
- Audit remains non-zero after an update — inspect every remaining dependency path; do not mark the advisory resolved.

## Privacy and Security

- Audit reports contain package metadata, not secrets. Keep them ignored because they are generated operational artifacts.
- Never place registry credentials, environment values, source text, tokens, or local paths in the advisory ledger.
- Do not suppress advisories. An accepted risk requires a separate explicit user decision outside this implementation plan.

## Rollout Notes

- Apply and validate one dependency root per change slice so regressions and lockfile movement remain attributable.
- Run the Markdown language-bundle plan before JavaScript remediation to avoid conflicting `package.json` and `bun.lock` edits.
- Do not commit `.audit/`, `dist/`, Cargo targets, mise downloads, or a second JavaScript lockfile.

## Risks and Mitigations

- **Live audit differs from the reported 18 findings** — trust the current audit, record the count difference, and map all live unique advisories.
- **Compatible parent update does not deduplicate every transitive path** — inspect all root paths and resolve each path before closure.
- **Tooling update changes lint/build semantics** — run the tool's own authoritative task immediately after its slice.
- **RustSec database or Bun advisory service is unavailable** — report the external outage; do not claim a clean result from cached assumptions.
- **Major migration is the only patch** — stop for approval instead of broadening scope silently.

## Open Questions

- Exact Bun and RustSec advisory IDs, paths, and patched targets remain unknown until Task 2 runs.
- Any `required-major` remediation needs a separate product/engineering approval.
