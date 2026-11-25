# Implementation Plan

**Goal:** Make Windows selection translation easier to recover and easier to start with a mouse, without reading text before the user asks.

**Inputs:** The comparison with STranslate in `F:/workspace/source/STranslate`, especially `Services/MouseHookService.cs`, `Services/MouseSelectionService.cs`, `Views/MouseSelectionIconWindow.xaml.cs`, and `ViewModels/MainWindowViewModel.cs` under `src/STranslate/`; Langnext's current Quick Translate flow.

**Assumptions:** Windows only. Ship Phase A first. Phase B is an optional follow-up and must pass a native window check before implementation. The plan assumes that a small, temporary button is preferable to automatic translation after selection.

**Architecture:** `QuickTranslateController` owns selection feedback, request ordering, and text delivery. Recovery uses the existing Screenshot Translate command. The optional mouse listener detects a possible text drag and sends only a point and an opaque target to Langnext; the floating button reads that target only after a click and reuses the selection delivery path.

**Tech Stack:** NSH 0.6.1, TSX, Rust, Win32 UI Automation and low-level mouse events, `nsh/test`, and mise. No new dependencies.

---

## Scope and priority

| Phase | Borrow from STranslate | Adapt for Langnext |
| --- | --- | --- |
| A — Ship first | Give the user a clear next step when selection read fails. | Keep the draft and results. Distinguish no selection from unreadable text. Offer explicit Screenshot Translate for unreadable text; never start capture automatically. |
| B — After native check | Show a small, non-activating translation button near a drag. | Off by default. Show it after a likely text drag. Do not read the selection or clipboard until the user clicks; the click uses UI Automation only. The selection shortcut remains the keyboard path. |

Both phases leave the `Alt+D`, `Alt+S`, and `Ctrl+C × 2` defaults and their existing activation policies intact. Do not add automatic translation after mouse-up, double-click or incremental mouse capture, a clipboard watcher, automatic simulated copy, new OCR channels, OCR geometry, or image overlays.

## File Map

| Phase | Action | Paths | Responsibility |
| --- | --- | --- | --- |
| A | Modify | `app/quick-translate-controller.ts`, `app/quick-translate.tsx`, `features/quick-translate/popup.tsx` | Keep selection feedback with the current request; show it near the source; call the existing `startOcr()` command. |
| A/B | Test | `app/quick-translate.test.tsx`, `app/__tests__/quick-translate-harness.tsx` | Test activation, feedback, capture, one-shot delivery, and mouse listener lifetime through the shell and its platform ports. |
| A/B | Modify | `locales/en.yml`, `locales/zh-CN.yml`, `DESIGN.md`, `README.md` | Localize new text, record motion before UI edits, and document the shipped behavior. |
| B | Create | `app/selection-hint.tsx` | Own one temporary button, its placement, and its dismissal. |
| B | Create/Modify | `src/quick_translate/selection_gesture.rs` (new), `src/quick_translate.rs`, `platform/quick-translate-native.ts`, `platform/selection-text.ts`, `app/quick-translate-controller.ts` | Detect candidate drags, deliver native events, and allow the controller to read the captured target without simulated copy. |
| B | Test | `tests/quick_translate_input.rs` | Verify the native gesture recognizer through its input and output, without UI Automation. |
| B | Create/Modify | `features/settings/selection-hint.ts` (new), `features/settings/shortcuts-section.tsx`, `App.tsx`, `app/shell.tsx` | Load the Windows-only preference, render its setting, and own the listener's start and stop. |

## Seams

- `QuickTranslateController.activateSelectionTranslate()` through `AppShell` and the Quick Translate window — failure status, draft preservation, and stale-result handling.
- The recovery button through `QuickTranslateController.startOcr()` and `ScreenCapturePort.capture()` — only an explicit press starts capture; only a confirmed crop can lead to recognition.
- Proposed Rust `SelectionDragRecognizer` — down, move, and up samples in; a qualifying release point out.
- Proposed `AppShell` selection-gesture binding and the floating button — dispatch one click through the existing read and delivery path; verify that passive gestures do not read text or start a request.
- Settings > Shortcuts through the shell — persisted opt-in and listener lifetime.

Confirm the scope and seams before writing tests. In each slice, add one behavior test, run the listed command to see it fail for the expected behavior, then implement and rerun that command. Add further cases in the same order. An import, setup, or type error is not a valid red result.

## Tasks

### A1. Explain why the selection did not arrive

**Seam:** Selection shortcut through `AppShell` and Quick Translate.

- [ ] **Red:** In `app/quick-translate.test.tsx`, invoke the shortcut with an existing draft and resolve `noSelection`. Assert that Quick Translate shows `No text is selected.` / `未选中文本。` and leaves the draft, results, and pin unchanged. Assert that it sends no translation request. Extend the existing selection boundary in the harness when needed.
- [ ] **Green:** In `app/quick-translate-controller.ts`, add a typed `selectionFeedback` accessor for `noSelection`, `unavailable`, or `null`. Set feedback only after the existing request and target checks. Map a blank `selected` result to `noSelection`. In `app/quick-translate.tsx` and `features/quick-translate/popup.tsx`, pass the accessor to the source-status row (`quick-translate-selection-status`), including when the source is empty or collapsed. Add `quickTranslate.selectionNoSelection` to both locale files. Use ordinary, muted text for this case. Do not move focus to the message.
- [ ] **Next cycle:** Test and add `unavailable` feedback (`Could not read the selection.` / `无法读取选中文本。`, `quickTranslate.selectionUnavailable`). Do not infer a permission error or the absence of a selection. Use the existing inline alert pattern. An OCR operation in progress keeps its status and is not interrupted by a failed selection read. After a valid failed read when OCR is idle, show the selection feedback in place of any earlier idle OCR message.
- [ ] **Next cycle:** Verify that a stale result or missing snapshot does not open or focus the window or show new feedback. Clear feedback on a new valid selection attempt, a draft edit or restore, a new source delivery, OCR start, or close. A failed read must not update the delivery sequence or clear existing results.

**Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter 'selection feedback:'`. Expect the new case to fail on missing or obsolete feedback before the change. After the change, each named case must run and pass.

### A2. Offer Screenshot Translate as a recovery action

**Seam:** Quick Translate's recovery button through `startOcr()`.

- [ ] **Red:** In `app/quick-translate.test.tsx`, resolve `unavailable` with an OCR service configured. Assert zero capture calls before a press. Press `quick-translate-selection-screenshot`, cancel the region overlay, and assert one capture call, the same draft and results, and no recognition or translation.
- [ ] **Green:** In `features/quick-translate/popup.tsx`, put a small secondary action beside the unreadable-selection message. Use the shared `Button` and `settings.shortcuts.screenshotTranslate` for its label. Show it only for `unavailable` when screen capture is supported and available to the controller; do not add it for `noSelection`. In `app/quick-translate.tsx`, wire it to the same `startOcr()` command as the header button. Let its existing readiness check handle missing OCR setup. Use the existing OCR focus return to the persistent header action after cancellation. Do not change the capture or OCR providers.
- [ ] **Next cycle:** Verify that a confirmed crop delivers recognized text once via the existing workflow, including with Auto-translate off. Verify that a missing OCR provider shows the existing configuration feedback without calling capture. See the existing screenshot, cancellation, and configuration cases for fixtures.

**Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter 'selection screenshot recovery:'`. Expect the action to be absent before the change. After the change, verify the button and all capture, delivery, and cancellation assertions.

### B0. Verify that a non-activating button is possible

- [ ] On real Windows, use a temporary `app/selection-hint.tsx` test window and `mise run dev`. Check the current `.nsh/types/nsh/desktop.d.ts` options: a frameless `Window` with `level="floating"`, `taskbar={false}`, `activate={false}`, `focusable={false}`, and `pointerEvents="auto"`. These declarations do not prove that clicking preserves focus on Windows.
- [ ] With selected text in Notepad and Chrome, verify that opening the window and pressing its button do not change the foreground target or prevent reading the same selection before Quick Translate opens. Verify that the button receives a pointer press and that it can be positioned on a second display with a different scale. Verify the equivalent keyboard path through the configured selection shortcut.
- [ ] If a click activates Langnext early, loses the selection, or cannot reach the button, stop Phase B. Remove the temporary wiring. Do not ship a focus workaround, cache text before consent, or change NSH for this release.

### B1. Detect a possible text drag without reading it

**Seam:** Rust `SelectionDragRecognizer`.

- [ ] **Red:** In `tests/quick_translate_input.rs`, add a sample sequence that must emit a single candidate on release after a drag passes a system-supplied threshold and reaches the standard I-beam cursor. Follow with separate negative cases for a click, a short drag, and a drag that never sees the I-beam. No candidate may fire before release.
- [ ] **Green:** In `src/quick_translate/selection_gesture.rs`, implement `SelectionDragRecognizer` with left-button down/move/up input, physical coordinates from the hook, and system drag thresholds (`SM_CXDRAG`, `SM_CYDRAG`). Single clicks and double-click-only sequences do not produce candidates. Keep it separate from the Win32 listener so the tests run without desktop access.
- [ ] Wire a new `QuickTranslateNative.onSelectionGesture` in `src/quick_translate.rs` and its TSX binding in `platform/quick-translate-native.ts`. Start a dedicated Windows message thread with `WH_MOUSE_LL`, following the existing native stop-handle pattern. Call `CallNextHookEx` without consuming input. Do not run UI Automation or clipboard calls in the callback. Publish press events for dismissal and candidate drag releases with the original release anchor and `selection_text` target snapshot; discard results without a valid target. Do not emit candidates for Langnext's own windows. Coalesce delivery instead of queuing every movement; stop and unhook with the binding. Confirm filtering and cleanup in Windows, not only in the recognizer tests.

**Red/green:** `mise exec -- cargo test --test quick_translate_input selection_drag`. Expect a missing or incorrect candidate before the implementation and all `selection_drag` cases to pass after. Run `mise run check` to generate and check the new native declarations.

### B2. Translate from the button only on a click

**Seam:** Floating button and platform binding through the existing selection read and delivery path.

- [ ] **Red:** Supply a candidate release through a test binding in the shell harness. No setting is needed for this slice; B3 connects the native binding to the saved preference. Assert that the button appears while Quick Translate is closed, with no selection read, clipboard call, capture, or translation before the click. Click the button and return a current selection. Assert one UIA-only read of the original target and one translation of the selected text with Auto-translate off.
- [ ] **Green:** Give `AppShell` an optional selection-gesture binding, following its existing `doubleCopy` boundary. Leave it unregistered in production until B3. In `app/selection-hint.tsx`, use the window verified in B0 and the shared `Button` with the existing `mdi:translate` icon, a localized `Translate Selection` name, and the configured shortcut as the alternative. Place it beside the release point with `resolveAnchoredDisplayPoint` from `platform/quick-translate.ts`; flip at work-area edges before clamping, and skip unresolved displays. Use the app's spacing and control size scale. Hide it after three seconds, on the next press outside it, on activation, or when Quick Translate or its screenshot workflow takes over. A press inside the button must not dismiss it before the click arrives. Keep only one candidate, and reject it on display and click if the captured target is no longer current.
- [ ] In `app/quick-translate-controller.ts`, add `activateSelectionFromHint(target)` and reuse the serialized selection read and `selection` delivery. Extend `SelectionTextPort.read` in `platform/selection-text.ts` with an explicit `uiaOnly` option; pass `false` for native `allowCopyFallback` on this path even if shortcut copy fallback is enabled. Do not take a fresh foreground snapshot in place of the captured target. If the user clicks and the target is still current but unreadable, use Phase A feedback. If stale, dismiss without opening Quick Translate. Drop delayed results superseded by a more recent explicit request, OCR start, or close.
- [ ] **Next cycle:** Test a stale click, a fast repeat click, and expiry or outside dismissal. Verify no unintended read or translation. Use the native check for actual foreground and multi-display behavior.

**Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter 'selection hint activation:'`. Expect the new action to be absent before the change. After the change, check no side effects before a click and one delivery for a current target.

### B3. Add a Windows-only opt-in

**Seam:** Settings > Shortcuts and the shell's listener binding.

- [ ] **Red:** In `app/quick-translate.test.tsx`, start without a saved preference and assert that the listener is not registered. Enable the new setting, assert one start, then disable it and assert one stop and dismissal of any current hint. Reload with the saved preference to verify persistence. Add failure and non-Windows cases in separate cycles.
- [ ] **Green:** Persist `settings.shortcuts.selectionHint` in `features/settings/selection-hint.ts`, with a default of off. Load it in `App.tsx`. Add a localized switch in `features/settings/shortcuts-section.tsx` (`Show Translate Button After Dragging Text` / `拖选文本后显示翻译按钮`). Reuse the existing switch and inline failure pattern. In `app/shell.tsx`, start at most one listener on supported systems while enabled. Stop it and dismiss the hint on disable, shell disposal, or quit. If startup fails, leave the feature inactive, show a localized error, and preserve existing shortcuts. If saving fails, keep the previous confirmed setting and runtime state.

**Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter 'selection hint setting:'`. Expect the switch or lifecycle behavior to be missing before the change. After the change, verify that disabled and non-Windows paths never start a listener.

## Failure behavior and privacy

- This plan does not weaken the current UI Automation checks, copy safeguards, or one-current-read rule. The default copy setting does not change. Phase B does not simulate copy, even after a click.
- A mouse gesture sends only a candidate point and target inside the app. It does not store or log selected text and does not contact a translation or OCR provider. The I-beam is a hint, not proof that the app supports selection reads; custom cursors may not trigger it.
- The recovery path uploads no screenshot without a press followed by a confirmed crop. A cancelled crop, failed read, or invalid target must not replace the draft, send old clipboard text, or initiate an OCR upload.

## Design and final validation

- Record the motion inventory in `DESIGN.md` before UI implementation. Feedback replaces text immediately in the existing status row; window fitting remains unchanged. The recovery button and hint use existing `pressScale` feedback. The hint opens and closes without travel so it does not move away from the pointer. The setting uses the shared switch motion. Check reduced motion for each change.
- Run `mise run verify` for each phase that ships. Run `mise exec -- nsh test app/quick-translate.test.tsx --target windows --filter 'selection'` separately: `mise run test-desktop` does not enumerate `app/*.test.tsx`.
- On Windows, check Notepad (selection and caret), Chrome (selection), a password field (unreadable without clipboard change), and VS Code (existing shortcut fallback and no whole-line import when there is no selection). For Phase B, also check dragging a file, dismissing or ignoring the hint, switching focus before a click, and pointer placement near edges on mixed-scale displays. Confirm that disabling the option restores existing behavior.
- Complete the NSH finishing and accessibility checks in light and dark, in English and Simplified Chinese, at the minimum Quick Translate size, with reduced motion, and with keyboard and Narrator. Test recovery via Tab and Enter, and verify focus after OCR cancellation. Report native checks separately from headless tests.

## Rollout

Phase A needs no setting or migration and can ship alone. Phase B adds one opt-in setting. Update `README.md` only for the phase that ships. Do not include existing unrelated worktree changes in either phase. The remaining decision is the B0 native check; it does not block Phase A.
