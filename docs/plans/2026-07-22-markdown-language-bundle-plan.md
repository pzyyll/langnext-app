# Implementation Plan

**Goal:** Replace the full Shiki language registry with an allowlisted, fine-grained Markdown highlighter and keep Markdown code out of the Quick Translate initial route chunk.

**Inputs:** The supplied bundle analysis; `src/components/markdown/MarkdownOutput.tsx`; `src/routes/translate/index.tsx`; `src/routes/quick-translate.tsx`; `vite.config.ts`; local `@streamdown/code@1.1.1`; Shiki fine-grained bundle documentation from `/shikijs/shiki`.

**Assumptions:**

- The supported fence languages are JavaScript, TypeScript, JSON, Markdown, Python, Rust, Bash, and SQL.
- Common aliases map to the allowlist: `js`, `jsx` → `javascript`; `ts`, `tsx` → `typescript`; `md`, `mdx` → `markdown`; `py` → `python`; `rs` → `rust`; `sh`, `shell`, `zsh` → `bash`.
- An unknown or empty fence language renders as unhighlighted code. It must not load a grammar.
- The user declined the seam confirmation prompt. The seams below are therefore plan assumptions.

**Architecture:** `MarkdownOutput` will use a project-owned Streamdown `CodeHighlighterPlugin`. The plugin will use `createBundledHighlighter` from `shiki/core`, the JavaScript regex engine, explicit theme loaders, and explicit language loaders. A shared lazy React boundary will load `MarkdownOutput` only when either translation route renders Markdown. A build-conformance task will reject oversized-warning regressions and non-allowlisted language assets instead of changing Vite warning thresholds.

**Tech Stack:** React 19, Streamdown 2, Shiki 3, Vite 8, Bun test, mise file tasks.

---

## Requirement Map

| Finding or requirement                                        | Plan coverage                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@streamdown/code` statically imports the full Shiki registry | Tasks 1–2 remove the package and introduce explicit loaders.                                               |
| Do not hide Vite warnings                                     | Task 4 fails on warnings; it does not change `chunkSizeWarningLimit`, logging, or generic chunk splitting. |
| Remove or truly split unused language assets                  | Tasks 1 and 4 allow only eight grammar modules and reject `emacs-lisp` or any other grammar asset.         |
| Main Translate already lazy-loads Markdown                    | Task 3 preserves this behavior through a shared boundary.                                                  |
| Quick Translate statically imports Markdown                   | Task 3 moves it behind the same lazy boundary.                                                             |
| Unknown languages must not pull the registry                  | Task 1 verifies the plain-code fallback.                                                                   |
| Build output does not prove browser requests                  | Task 4 adds a production artifact gate; Rollout Notes retain a focused Network-panel check.                |
| Do not perform unrelated Vite tuning                          | Explicitly out of scope.                                                                                   |

## File Map

- Create: `src/components/markdown/-codeHighlighter.ts` — project-owned Streamdown code plugin, language aliases, loaders, themes, and async token cache.
- Create: `src/components/markdown/-codeHighlighter.test.ts` — plugin contract tests for allowlisted languages, aliases, async highlighting, and unknown-language fallback.
- Create: `src/components/markdown/LazyMarkdownOutput.tsx` — shared `lazy()` and `Suspense` boundary.
- Create: `src/components/markdown/LazyMarkdownOutput.test.tsx` — component-boundary tests for empty fallback and deferred Markdown rendering.
- Create: `.mise/tasks/check/frontend-bundle` — production build and emitted-asset conformance gate.
- Modify: `src/components/markdown/MarkdownOutput.tsx` — replace `@streamdown/code` with the project plugin.
- Modify: `src/routes/translate/index.tsx` — consume the shared lazy boundary and remove the route-local `lazy()` declaration.
- Modify: `src/routes/quick-translate.tsx` — consume the shared lazy boundary instead of importing `MarkdownOutput` directly.
- Modify: `package.json` — remove `@streamdown/code`; add the directly imported Shiki packages at compatible Shiki 3 versions.
- Modify: `bun.lock` — record only the dependency changes from this plan.
- Modify: `vite.config.ts` — enable the production manifest only if the bundle check needs import-graph inspection; do not change warning limits or warning filters.

Every new code or task file must start with the repository-required two-line `ABOUTME:` header.

## Seams

- **Seam:** `createMarkdownCodeHighlighter()` as a Streamdown `CodeHighlighterPlugin` — verifies supported language policy, alias normalization, asynchronous token delivery, cache behavior visible to callers, and unknown-language fallback.
- **Seam:** `<LazyMarkdownOutput>` — verifies that route callers get the existing `MarkdownOutputProps` behavior through a deferred module boundary.
- **Seam:** `mise run check:frontend-bundle` and `dist/assets` — verifies the production import graph and emitted assets without suppressing warnings.

## Tasks

### Task 1: Add the allowlisted highlighter contract

**Seam:** `createMarkdownCodeHighlighter()` as a Streamdown `CodeHighlighterPlugin`.

**Outcome:** The project has a tested code-highlighter interface that names the exact supported language policy before it imports Shiki grammars.

**Files:**

- Create: `src/components/markdown/-codeHighlighter.test.ts`
- Create: `src/components/markdown/-codeHighlighter.ts`

**Steps:**

- [ ] **Red:** Add tests that call `getSupportedLanguages()` and `supportsLanguage()` through the plugin interface. Assert the eight canonical names, every listed alias, and rejection of `emacs-lisp`, an empty string, and an arbitrary unknown name.
- [ ] **Red:** Add a test that calls `highlight()` for `javascript`. Assert the first call returns `null`, the callback later receives non-empty token lines, and a later identical call returns the cached token result.
- [ ] **Red:** Add a fence-fallback test through the plugin interface. Assert an unknown language is unsupported and does not invoke a grammar loader. Expose loader injection only as a constructor dependency if this observation cannot be made through the normal plugin result; do not export cache internals.
- [ ] Run the test before implementation. Confirm it fails because `./-codeHighlighter` does not exist.
- [ ] **Green:** Define named constants for canonical languages, aliases, two GitHub themes, cache key limits, and all non-trivial values.
- [ ] **Green:** Use `createBundledHighlighter` from `shiki/core` with `createJavaScriptRegexEngine({ forgiving: true })`.
- [ ] **Green:** Define dynamic loaders only for the eight language modules under `@shikijs/langs/*` and `github-light` / `github-dark` under `@shikijs/themes/*`. Do not import `shiki`, `shiki/langs`, `bundledLanguages`, or `bundledLanguagesInfo`.
- [ ] **Green:** Implement the Streamdown async contract: return cached tokens synchronously; return `null` while a selected grammar loads; coalesce callbacks for the same request; report a failed load once and leave code renderable as plain text.
- [ ] **Green:** Keep unknown and empty language names outside the loader map. `supportsLanguage()` must return `false`, so Streamdown uses its plain-code path.

**Validation:**

- Run (red): `bun test src/components/markdown/-codeHighlighter.test.ts`
- Expected: Bun fails with `Cannot find module "./-codeHighlighter"`.
- Run (green): `bun test src/components/markdown/-codeHighlighter.test.ts`
- Expected: All plugin contract tests pass. No test imports or inspects private cache maps.

### Task 2: Replace the full-registry package

**Seam:** `MarkdownOutput` with fenced Markdown input.

**Outcome:** Markdown uses the project plugin, and the direct dependency graph no longer contains `@streamdown/code`.

**Files:**

- Modify: `src/components/markdown/MarkdownOutput.tsx`
- Modify: `package.json`
- Modify: `bun.lock`
- Test: `src/components/markdown/-codeHighlighter.test.ts`

**Steps:**

- [ ] **Red:** Extend the highlighter test with a real tokenization scenario for one selected language and both configured themes. Run it while `MarkdownOutput` still imports `@streamdown/code`; the dependency-removal assertion below must fail.
- [ ] Add a test assertion that `package.json` does not list `@streamdown/code` and does list every package imported by `-codeHighlighter.ts` as a direct dependency.
- [ ] **Green:** Replace `createCodePlugin()` in `MarkdownOutput.tsx` with one stable project-plugin instance. Keep the existing themes, streaming mode, raw copy source, controls, and line-number behavior.
- [ ] **Green:** Use Bun only to remove `@streamdown/code` and add compatible Shiki 3 direct dependencies. Do not hand-edit `bun.lock` and do not introduce another lockfile.
- [ ] **Green:** Run `bun install --frozen-lockfile` after the lockfile update to prove the lock is reproducible.
- [ ] Confirm `bun pm ls --all` has no dependency path to `@streamdown/code`. A remaining Shiki dependency is expected because the project now imports it directly.

**Validation:**

- Run (red): `bun test src/components/markdown/-codeHighlighter.test.ts`
- Expected: The dependency-policy assertion fails while `@streamdown/code` remains in `package.json`.
- Run (green): `bun test src/components/markdown/-codeHighlighter.test.ts && bun install --frozen-lockfile`
- Expected: Tests pass and Bun reports no lockfile change.

### Task 3: Share the Markdown lazy boundary

**Seam:** `<LazyMarkdownOutput>`.

**Outcome:** Both translation routes defer the heavy Markdown renderer until Markdown output is actually rendered.

**Files:**

- Create: `src/components/markdown/LazyMarkdownOutput.tsx`
- Create: `src/components/markdown/LazyMarkdownOutput.test.tsx`
- Modify: `src/routes/translate/index.tsx`
- Modify: `src/routes/quick-translate.tsx`

**Steps:**

- [ ] **Red:** Register Happy DOM in the test file, render `<LazyMarkdownOutput text="plain" />`, and assert that the Suspense fallback is initially empty and the Markdown content appears after the dynamic import resolves.
- [ ] Run the test before implementation. Confirm it fails because the shared boundary does not exist.
- [ ] **Green:** Implement one `lazy(() => import("./MarkdownOutput"))` at module scope and wrap it in `Suspense` with a layout-neutral `null` fallback. Re-export the same `MarkdownOutputProps` surface.
- [ ] **Green:** Replace the local lazy declaration in `src/routes/translate/index.tsx` with the shared component.
- [ ] **Green:** Replace the static `MarkdownOutput` import in `src/routes/quick-translate.tsx` with the shared component. Keep the existing conditional render, text, and streaming props unchanged.
- [ ] Do not move route state, Markdown mode state, or translation logic.

**Validation:**

- Run (red): `bun test src/components/markdown/LazyMarkdownOutput.test.tsx`
- Expected: Bun fails with `Cannot find module "./LazyMarkdownOutput"`.
- Run (green): `bun test src/components/markdown/LazyMarkdownOutput.test.tsx`
- Expected: The deferred component test passes with no unhandled React `act()` warning.

### Task 4: Enforce the production bundle contract

**Seam:** `mise run check:frontend-bundle` and `dist/assets`.

**Outcome:** A repeatable check proves that the build has no Vite warning, no full Shiki registry, no unused grammar asset, and a separate lazy Markdown chunk.

**Files:**

- Create: `.mise/tasks/check/frontend-bundle`
- Modify: `vite.config.ts` only if a manifest is required

**Steps:**

- [ ] **Red:** Add the file task with checks for the current known regression: build output containing a Vite/Rolldown warning, emitted `emacs-lisp` assets, or a static Quick Translate → `MarkdownOutput` import path. Run it against the current implementation and confirm at least the language-asset check fails.
- [ ] **Green:** Make the task run `mise run build`, preserve the build exit status through `tee`, and inspect `dist/assets` plus `dist/.vite/manifest.json` when enabled.
- [ ] **Green:** Fail if build output contains warning diagnostics. Do not filter warnings in Vite.
- [ ] **Green:** Fail if an emitted grammar asset is outside the canonical allowlist or if an asset/module path contains `emacs-lisp`, `bundledLanguages`, or `@streamdown/code`.
- [ ] **Green:** Verify that the actual `MarkdownOutput` module is reached as a dynamic import from both route paths, not a static Quick Translate dependency.
- [ ] Keep the task cross-platform under the repository's existing Bash-based mise environment. Name non-trivial limits and patterns in the task.

**Validation:**

- Run (red): `mise run check:frontend-bundle`
- Expected: The task fails on the existing full-language output before Tasks 1–3 are complete.
- Run (green): `mise run check:frontend-bundle`
- Expected: Build succeeds with zero Vite/Rolldown warnings; only allowlisted language/theme chunks exist; no `emacs-lisp` asset exists; Markdown remains dynamically loaded.

## Final Validation

Run in order:

1. `bun install --frozen-lockfile`
   - Expected: Installation succeeds and `bun.lock` remains unchanged.
2. `bun test src/components/markdown/-codeHighlighter.test.ts src/components/markdown/LazyMarkdownOutput.test.tsx`
   - Expected: All targeted frontend tests pass.
3. `bun test`
   - Expected: The complete Bun test suite passes.
4. `mise run typecheck`
   - Expected: TypeScript reports no error.
5. `mise run lint`
   - Expected: ESLint and oxlint report no error.
6. `mise run format:check`
   - Expected: oxfmt and rustfmt report no change.
7. `mise run check:frontend-bundle`
   - Expected: Production build succeeds with zero warnings and the bundle contract passes.

## Failure Behavior

- Unknown fence language — Streamdown renders plain code. The plugin does not import a grammar.
- Selected grammar load failure — keep code readable without highlighting; log one non-sensitive error; do not reject Markdown rendering.
- Duplicate highlight request while loading — coalesce callbacks and issue one grammar/highlighter load.
- Build warning or non-allowlisted language asset — `check:frontend-bundle` exits non-zero. Do not suppress the warning.

## Privacy and Security

- Markdown source remains local to the existing renderer. Shiki loaders do not send code over the network.
- Error logs must not include full translated code. Log the language and error object only.
- Keep Streamdown's existing HTML sanitization and copy-source behavior unchanged.

## Rollout Notes

- After automated validation, run the production app and inspect the browser Network panel for four cases: plain text, a JavaScript fence, an `emacs-lisp` fence, and first open of Quick Translate.
- Expected: plain text does not request a grammar; JavaScript requests only its selected grammar/theme dependencies; `emacs-lisp` remains plain and requests no grammar; Quick Translate does not fetch the Markdown chunk until Markdown output renders.
- Record before/after `dist/assets` sizes in the work item or PR. Do not commit `dist`.

## Risks and Mitigations

- **Streamdown plugin contract changes during dependency remediation** — keep the plugin typed against Streamdown's exported `CodeHighlighterPlugin` and run the component and build checks after every Streamdown update.
- **Alias omission changes existing fence behavior** — centralize and test the explicit alias map.
- **JavaScript regex engine supports fewer grammar features than Oniguruma** — validate representative fixtures for all eight languages. Switch to the fine-grained Oniguruma engine only if a selected grammar fails; do not restore the full bundle.
- **Manifest checks become coupled to Vite output shape** — inspect stable manifest fields and emitted assets, not hash names.

## Open Questions

- The language allowlist and seams are assumptions because the confirmation prompt was declined. Change the constants and table-driven tests together if product support differs.
