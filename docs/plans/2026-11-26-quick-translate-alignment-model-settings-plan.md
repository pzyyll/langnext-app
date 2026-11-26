# Implementation Plan

**Goal:** Separate offline model downloads from the Sentence alignment switch in **Settings → Application → Quick Translate**. Turn on alignment only when a valid local model can run.

**Inputs:** The confirmed settings interaction in the conversation. Keep the current full-input translation flow, the offline E5 model, and the settings progress bar. The current switch starts or cancels model downloads in `src/features/settings/quick-translate.ts`.

**Assumptions:** Windows only. Show a model name and its download state for the single supported model, **Multilingual E5 Small**. Do not add a one-item dropdown. A future model catalog and switching between different models are outside this plan. A pending **Download and enable** request does not survive an app restart.

**Architecture:** The app-wide model store owns file checks, download progress, and cancellation. Settings owns the saved switch and any request to enable after download. Quick Translate consumes the effective enabled state. It does not manage downloads or send another translation request.

**Tech Stack:** NSH 0.7.0, TSX, the existing Rust extension and INT8 ONNX model, `nsh/test`, and mise. No new dependency or model.

---

## Interaction Contract

- **Open settings:** Show **Sentence alignment** and **Semantic model** as separate rows. The model row shows the model name. Show **Downloaded** only when all pinned files pass verification. Otherwise show **Download**, progress, or retry feedback. Checking local files sends no request.
- **Select Download:** Start the transfer. Show its actual percentage and **Cancel** below the model row. Do not turn on alignment. The download continues if the user leaves settings.
- **Turn on alignment with a usable model:** Use the installed model without downloading again. Show the switch as on only after the local runtime is ready and the preference is saved.
- **Turn on alignment with no installed model:** Keep the switch off and ask for confirmation. Name **Multilingual E5 Small** and the approximate size (**135 MB**). Offer **Cancel** and **Download and enable**. Do not change the preference or send a request before confirmation.
- **Confirm Download and enable:** Reuse the model row and download worker. Show **Turns on after download** while the request is pending. Keep the switch off until file verification, runtime preparation, and storage succeed.
- **Cancel or fail a download:** Clear the pending enable request and keep the switch off. Show **Retry** for a failed transfer. Retry from the model row is a manual download and does not turn on alignment.
- **Turn off alignment:** Clear its preview for open results. Do not remove the model, cancel a manual download, clear the translation, or send it again. The model row's **Cancel** controls the transfer.

While a manual download is running with alignment off, disable the switch temporarily. The model row shows progress. The user can enable alignment after the manual download finishes. If the user exits the app while a transfer or enable request is pending, do not start another transfer at launch. If the saved switch is on but the model is missing or unusable at launch, keep alignment off and clear that saved value. A valid model restores the saved on state without network access.

## File Map

- Modify `src/features/quick-translate/alignment-model.ts` to separate local status checks from transfer commands. Return a final outcome from the shared download operation.
- Modify `src/features/settings/quick-translate.ts` to own effective activation, the saved preference, and pending enable intent.
- Modify `src/features/settings/quick-translate-section.tsx` to add the model row and consent dialog. Reuse `Card`, `AppDialog`, `Button`, `Progress`, and `Switch` from `src/components/ui/`.
- Modify `ext/langnext-native/src/sentence_alignment.rs` and `ext/langnext-native/src/sentence_alignment/semantic.rs` to prepare the verified local runtime without aligning text. Add a Rust test beside the current real-model test.
- Modify `src/app/quick-translate.tsx` and `src/features/quick-translate/popup.tsx` to follow usable activation and clear stale previews. Keep the bootstrap call to `loadSentenceAlignment()` in `App.tsx` and `src/app/__tests__/quick-translate-harness.tsx`.
- Create `src/features/quick-translate/alignment-model.test.ts` and `src/features/settings/quick-translate.test.ts` for the download and settings controllers. Update the existing alignment cases in `src/app/quick-translate.test.tsx` for the new UI.
- Modify `locales/en.yml`, `locales/zh-CN.yml`, `DESIGN.md`, and `README.md`. Record motion in `DESIGN.md` before the UI edits.

## Seams

- The public `alignmentModel` store: offline status checks, one shared transfer, progress, verified completion, cancellation, and retry. Construct it with `createAlignmentModel()` so tests can supply native file operations and the existing `FetchLike` HTTP boundary. Use `SentenceAlignmentNative` and `createHttpFetch` in production.
- The public settings controller through `loadSentenceAlignment()` and `selectSentenceAlignment()`: saved preference, runtime readiness, and pending **Download and enable** intent. Use `createSentenceAlignmentController()` with the model store, native preparation, and `Storage` boundaries. Test with small fixtures at those boundaries.
- Settings → Application → Quick Translate in `src/app/quick-translate.test.tsx`: the switch, model row, consent dialog, and download controls through the existing app harness. Use `open({ network })` for HTTP responses and existing native module seams for operations that need local fixtures.
- `SentenceAlignmentNative.prepareSemanticModel()` (new) and Quick Translate's result preview: require a local runtime, show the full translation unchanged, and clear stale alignment when disabled.

Confirm these test seams before implementation. Follow `/tdd`: for each case, run the listed test command red, implement the smallest behavior, and rerun green. A type, import, or setup error is not a valid red result.

## Tasks

### 1. Separate the download lifecycle from the switch

**Seam:** `alignmentModel` store. **Outcome:** A caller can check, download, or cancel without changing settings.

- [ ] **Red:** In `src/features/quick-translate/alignment-model.test.ts`, use a small model fixture at the native file and HTTP boundaries. Check local status without a request, then start twice while one transfer is pending. Assert one set of asset requests, a progress update, and a ready outcome only after verification.
- [ ] **Green:** In `alignment-model.ts`, expose `checkInstalled(): Promise<boolean>`, `download(): Promise<"ready" | "cancelled" | "error">`, and `cancel()`. A concurrent `download()` joins the pending transfer; it does not supersede it. A valid installation returns `ready` without a request. Preserve the pinned URLs, streamed writes, time limit, and native checksum checks. Keep the existing switch wiring working until Task 3. Do not add a second download implementation.
- [ ] In the next cycles, verify that cancel aborts the stream, drops temporary data, and settles before another request begins. A failed file verification must not report **Downloaded**. After cancel, a file that passed verification may remain on disk; recheck its status without enabling alignment.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/alignment-model.test.ts --filter 'alignment download:'`. Expect missing completion or an extra request before the change. Expect one transfer, correct completion, and clean cancellation afterward.

### 2. Add the independent model row

**Seam:** Settings controls through the app harness. **Outcome:** The user can download or retry while alignment is off.

- [ ] **Red:** In `src/app/quick-translate.test.tsx`, add an `alignment settings: model row` case. From Settings, assert that the model name and **Download** appear, the switch is off, and there are no requests. Press **Download**, hold the response, and assert the progress bar appears under the model row and the switch stays off and is temporarily disabled. Cancel and assert the bar disappears and the off switch can be used again. Test a failed transfer with **Retry** in the next cycle.
- [ ] **Green:** In `quick-translate-section.tsx`, place the model row below the switch, with test IDs `settings-alignment-model`, `settings-alignment-download`, and `settings-alignment-download-cancel`. Keep the existing progress and error test IDs. Render status outside any conditional on the switch. Disable the off switch while a manual transfer is pending. Reuse the existing percent and error copy from both locales. Add `semanticModel`, `alignmentModelDownloaded`, and `downloadAlignmentModel` under `settings.quickTranslate`; use the shared cancel and retry labels. Start only on press, and hide transfer controls once the verified badge is shown. No dropdown, selector state, or second installed model.
- [ ] Verify the model row still shows progress on return from another settings page. Model transfers belong to the app, not the page's lifetime. Preserve the old switch path only until Task 3; do not ship this intermediate state.

**Red/green:** `mise exec -- nsh test src/app/quick-translate.test.tsx --filter 'alignment settings: model row'`. Expect the independent row or action to be absent before the change. After it, expect no network before the button and no activation from the model row.

### 3. Gate activation on local readiness and confirm downloads

**Seams:** Settings controller, consent dialog, and native model preparation. **Outcome:** The switch shows active alignment, not a queued installation.

- [ ] **Red:** In `src/features/settings/quick-translate.test.ts`, ask to enable with no local model. Assert no download and no persisted on value. Confirm the request and resolve installation while holding runtime preparation. Assert the switch remains off until preparation and the storage write succeed. Verify in separate cycles that manual download, cancellation, transfer failure, or a failed save do not turn on the switch.
- [ ] **Green:** In `quick-translate.ts`, replace the current `apply(true) → ensureInstalled()` binding with independent activation and download commands. Keep pending enable intent in memory, tied to the confirmed operation. Use a token to discard late completions after cancel. Set the effective and saved switch only after preparation and a successful storage write. Keep the switch off during enable preparation; do not let a manual retry consume an old intent. Turning off updates the preference and preview only.
- [ ] Add `SentenceAlignmentNative.prepareSemanticModel(): Promise<boolean>` in `sentence_alignment.rs`. Reuse the blocking worker and the verified runtime cache in `semantic.rs`. Put model initialization in a helper shared by preparation and `align_semantic`. File verification alone can show **Downloaded**, but only successful preparation permits activation. Test missing assets without network and run the real-model check in final validation.
- [ ] **Next red/green:** Replace the old immediate-download test in `src/app/quick-translate.test.tsx` with `alignment settings: consent`. In `quick-translate-section.tsx`, open the shared `AppDialog` on an enable attempt with missing files. Keep dialog visibility local to Settings. Escape, dismiss, or **Cancel** must return focus and send no request. **Download and enable** starts one transfer and keeps the switch off until ready. Hold the first response and assert one GET while it is pending. Rework the existing `turning off aborts the download` case so it presses **Cancel** in the model row and confirms that a retry starts after cleanup. Set new locale keys under `settings.quickTranslate`: `alignmentDownloadTitle`, `alignmentDownloadDescription`, `downloadAndEnable`, `alignmentPendingEnable`, and `alignmentPrepareFailed`. Keep the model name and size in the confirmation. Keep the existing info tooltip.

**Red/green:** `mise exec -- nsh test src/features/settings/quick-translate.test.ts --filter 'alignment activation:'` and `mise exec -- nsh test src/app/quick-translate.test.tsx --filter 'alignment settings: consent'`. Before each change, expect early activation, an unsolicited transfer, or a missing dialog. Afterward, expect confirmed activation only and correct cancellation and recovery.

### 4. Verify startup and the open Quick Translate result

**Seams:** Settings restore and live Quick Translate through the app harness. **Outcome:** Startup never downloads on its own and disabling never retranslates.

- [ ] **Red:** In `quick-translate.test.ts`, restore a persisted on value with missing assets. Assert no request, no effective enable, and stored off after the check. Restore a valid model in a separate cycle and assert on without a request. Keep the first check asynchronous so it does not delay app startup.
- [ ] **Green:** Make `loadSentenceAlignment()` resolve after the preference read. Schedule the local file check and any runtime preparation without awaiting them in bootstrap. Prepare the runtime only if the saved value is on. If assets or preparation fail, stay off and clear the stored on value. On a failed storage write, keep effective state off and expose the save error. Use the same operation token to keep late startup work from replacing an explicit choice. Do not restore a pending intent.
- [ ] **Next red/green:** Extend the existing `aligns the complete result` case in `src/app/quick-translate.test.tsx` and name it `alignment settings: existing result`. Seed a ready model, translate the full input once, then disable alignment from the main settings while the result stays open. Assert no highlight or preview focus, unchanged output and copy text, and one translation request. In a separate case, run translation while an enable request downloads; show and copy the complete result before the model is ready. In `src/app/quick-translate.tsx` keep the popup flags tied to effective activation, not file download status alone. In `popup.tsx`, keep the current result identity checks and drop stale previews. A result that the semantic worker cannot align remains visible without a rule-only preview in production.

**Red/green:** `mise exec -- nsh test src/features/settings/quick-translate.test.ts --filter 'alignment startup:'` and `mise exec -- nsh test src/app/quick-translate.test.tsx --filter 'alignment settings: existing result'`. Expect a startup transfer or wrong preview state before the change and none afterward.

## Final Validation

- Run all focused red/green commands, `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter 'sentence highlight'`, and `mise run verify`. Expect focused tests, formatting, lint, type checks, build, and full tests to pass. Report a timeout or failure separately; do not count a partial run as a pass.
- Run `mise exec -- nsh test src/app/quick-translate.test.tsx --target windows --filter 'alignment settings: consent'`. Keep this case usable without headless-only module overrides. On Windows, inspect the model row, progress, confirmation, focus return, and retry in light and dark. Check that Tab, Space, and Escape work without a pointer.
- With the verified artifacts in `LANGNEXT_ALIGNMENT_MODEL_DIR`, run `mise exec -- cargo test --locked --manifest-path ext/langnext-native/Cargo.toml aligns_reported_prose_and_markdown_with_the_real_model -- --ignored`. Extend the existing test to exercise the shared runtime preparation before aligning. Check that validated preparation adds no request and that the two text examples still match. Use `mise run dev` in an isolated Windows profile to verify one complete first-use download before claiming end-to-end download coverage. Record if the environment cannot run it.

## Failure Behavior

- Cancel, request failure, or invalid files: stop the transfer, remove incomplete temporary resources, clear pending enable intent, and keep the model row available for retry.
- Download verified but runtime cannot load: preserve the installed files and show **Could not load the alignment model**. Keep the switch off. Model-file verification success is not activation success.
- Save fails or late work comes back after disable: do not enable, recreate the preview, or alter the completed translation.

## Privacy and Rollout

- Only the pinned model files go over the model download transport. Never send or log source or result text for model checks, downloads, or preparation. Keep all inference local. Keep the existing cache and verify it; do not redownload valid assets. Keep the current preference key.
- Keep the switch default off. There is no migration, installed file deletion, model selector, or model registry in this release. The floating Quick Translate window does not gain a download control or dialog.

## Open Questions

None for this release. Revisit model selection and deferred switching only when a second supported model is ready to ship.
