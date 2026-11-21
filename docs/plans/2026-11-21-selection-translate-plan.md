# Implementation Plan

**Goal:** On Windows, press `Alt+D` after selecting text to open Quick Translate and translate the selection as if the user had pressed `Ctrl+C` twice.

**Inputs:** The request for a separate `Alt+D` selection shortcut, the Windows UI Automation research, and the existing [Quick Translate behavior](../../README.md#quick-translate).

**Assumptions:**

- The first release is Windows only. It reads the selection on demand through UI Automation. It does not monitor selections, simulate copy, read or write the clipboard, or fall back to OCR.
- If the target is still current but has no readable selection, open or focus Quick Translate without changing the draft or its results. If the request is stale, do not open or focus the popup.
- Keep the tray action, `Alt+Shift+D` (**Open Quick Translate**), `Alt+Shift+S` (**Screenshot Translate**), and double-copy behavior. **Translate Selection** works even when double-copy and Auto-translate are off.

**Architecture:** NSH delivers the global shortcut to the Quick Translate controller. A Rust port reads the selection from the original foreground control before the popup takes focus. The controller delivers valid text through the same draft and translation path as double-copy. Store only the shortcut setting.

**Tech Stack:** NSH 0.6.1 Mixed, TSX, Rust, Windows UI Automation (UIA), `windows` 0.62, `nsh/test`, and mise.

---

## File Map

| Change | Paths and responsibility |
| --- | --- |
| Create | `src/selection_text.rs`, `src/selection_text/windows.rs` — typed NSH bridge and Windows selection reader. |
| Modify | `src/lib.rs`, `Cargo.toml`, `Cargo.lock` — register the bridge and add the Windows-only dependency. |
| Create | `src/selection_text/desktop_tests.rs` — real Windows UIA tests with a focused Win32 text control. |
| Create | `platform/selection-text.ts` — typed selection port and production bridge wrapper. |
| Modify | `app/quick-translate-controller.ts`, `app/quick-translate.tsx` — activation, focus order, request lifetime, and shortcut registration. |
| Modify | `features/quick-translate/session.ts`, `features/quick-translate/popup.tsx` — selection delivery kind and the existing one-line preview. Keep the session's translation logic. |
| Modify | `features/settings/shortcuts.ts`, `locales/en.yml`, `locales/zh-CN.yml` — independent shortcut setting and localized row label. Reuse `features/settings/shortcuts-section.tsx` without changing its layout. |
| Test | `app/quick-translate.test.tsx`, `app/__tests__/quick-translate-harness.tsx`, `.mise/tests/shortcut-registration.test.ts` — popup flow, request races, settings, and real shortcut registration. |
| Modify | `README.md`, `docs/ui/DESIGNE.md` — supported surfaces, shortcut conflict recovery, and existing interaction states. |

## Seams

1. **Native selection reader:** The Rust `snapshot`, `is_current`, and `read_target` functions behind `SelectionTextNative` return only the current foreground selection, or a typed no-text result. Test against a real Win32 control.
2. **Shortcut to popup:** The `Alt+D` action in `AppShell` waits for text, then opens Quick Translate and sends one translation action. Test the UI and HTTP boundary with a controlled OS selection port.
3. **Controller lifetime:** `activateSelectionTranslate()` applies only a current result and cannot replace a newer draft or reopen a closed popup. Test via controller actions and public state.
4. **Shortcut settings:** The new row edits, clears, and resets its own native binding. Test through Settings and the existing Windows shortcut test.

## Tasks

Work one red/green case at a time. Each red run must find the named test and fail on the expected assertion. For a new Rust export, add a typed stub if needed so the test can run. Use test doubles only at the OS or HTTP boundary in the existing test harness. Do not add a production test mode.

### 1. Read the foreground selection in Rust

**Seam:** Native selection reader. **Outcome:** The native port returns the selected text before any window takes focus.

**Files:** Create `src/selection_text.rs`, `src/selection_text/windows.rs`, and `src/selection_text/desktop_tests.rs`. Modify `src/lib.rs`, `Cargo.toml`, and `Cargo.lock`.

- [ ] **Red:** Add `desktop_selection_text_reads_only_the_selected_range`. Start a visible test window with a multiline Win32 `EDIT` control on a UI thread that pumps messages. Focus the edit and use `EM_SETSEL` to select a known substring of a larger fixture. Assert that the reader returns the exact substring. If Windows does not give the fixture foreground focus, fail the test setup with an explicit message; do not count that as red. Mark the test `#[ignore]` for unattended runs.
- [ ] **Green:** Add the `SelectionTextNative` module and register it in `src/lib.rs`. Follow the `PropEnum` status and `JsObject` result pattern in [`src/screen_capture.rs`](../../src/screen_capture.rs). Expose `snapshot(): string | null`, `isCurrent(target: string): boolean`, and `read(target: string)` returning a Promise. The result status is `selected`, `noSelection`, `unavailable`, or `stale`; only `selected` carries `text`. On non-Windows builds, return no target and an unavailable read.
- [ ] **Green — capture target:** `snapshot` uses `GetForegroundWindow` and `GetGUIThreadInfo` for the foreground thread. Encode the top-level and focused HWNDs as an opaque string, not as JS numbers. A null foreground gives no target. A foreground with no identifiable focused control gives `unavailable` if still current. `isCurrent` compares against a fresh snapshot. Check the target before and after reading.
- [ ] **Green — read selection:** Add `windows = "0.62"` under `cfg(windows)` with `Win32_System_Com`, `Win32_UI_Accessibility`, and `Win32_UI_WindowsAndMessaging`. This matches the binding line used by the NSH 0.6.1 Windows host. Keep the existing `windows-sys` dependency. Use NSH `blocking` as in [`src/screen_capture/windows.rs`](../../src/screen_capture/windows.rs) so no COM call runs on the engine thread. Initialize COM as MTA on the worker, create `CUIAutomation8` as `IUIAutomation2`, and release COM objects before uninitializing COM. Use named initial timeouts of 250 ms per connection or transaction and a 750 ms read budget checked between calls. A timeout is not a guarantee that an in-flight COM call can be interrupted.
- [ ] **Green — identify the text provider:** Start with `GetFocusedElement`. Before reading text, require a native HWND on the element or its raw-view ancestor chain whose `GA_ROOT` matches the captured foreground. Virtual elements can have a zero HWND. If the focused element has no supported `TextPattern`, try its ancestors only, up to eight levels and never above the foreground root. Reject a protected focused element before trying any ancestor. Check `CurrentIsPassword` on each candidate before reading it; stop if the check fails. Once a supported pattern yields an empty selection, stop; do not use an ancestor's selection instead.
- [ ] **Green — read ranges:** Use `IUIAutomationTextPattern.GetSelection` and `GetText(-1)` on the returned ranges. Treat a caret-only result or all-whitespace text as `noSelection`. Preserve the text as returned; join multiple nonempty ranges with a newline in provider order. Do not use `DocumentRange`, `ValuePattern`, or partial text after an API failure. Before returning text, compare the UIA focused element with the initial one using `CompareElements`. A changed target or focus gives `stale`; a denied or unsupported read gives `unavailable`.
- [ ] **Repeat red/green:** In the same fixture, test a caret without selection, a password control, and a captured target that loses foreground focus. Expect `noSelection`, `unavailable`, and `stale`, respectively, with no text. Reuse the fixture and close its windows after each case.

**Validation:** From an active Windows desktop, run `mise exec -- cargo test --lib desktop_selection_text_ -- --ignored --test-threads=1 --nocapture` before and after each case. The first red run reports `unavailable` instead of the selected substring. Green returns the expected range or no-text status. Run `mise run check` after registering the module to verify the generated NSH declarations.

### 2. Open Quick Translate with the selected text

**Seam:** Shortcut to popup. **Outcome:** `Alt+D` sends the selected text through the existing immediate translation path.

**Files:** Create `platform/selection-text.ts`. Modify `app/quick-translate.tsx`, `app/quick-translate-controller.ts`, `features/quick-translate/session.ts`, `features/quick-translate/popup.tsx`, `features/settings/shortcuts.ts`, both locale files, and the two app test files in the file map.

- [ ] **Red:** Add `selection translate: waits for the selection, then translates once with Auto-translate off` in `app/quick-translate.test.tsx`. In the harness, inject a deferred selection port and bind `alt+d` through the existing `globalShortcut` double. Use one expanded preset, a fixed language pair, Auto-translate off, and double-copy off. Press `Alt+D` and wait for the harness to report that a read started. Assert no popup and no request while the read is pending. Resolve a multiline result: assert the one-line preview is visible, the one translation request contains the full selected text, and the clipboard read count stays zero. Red fails because `Alt+D` never starts the read.
- [ ] **Green — bind the action:** Add `selection-translate` to `TRANSLATION_SHORTCUTS`, `DEFAULT_SELECTION_TRANSLATE_SHORTCUT = "alt+d"`, and `SELECTION_TRANSLATE_SHORTCUT_STORAGE_KEY = "settings.shortcuts.selectionTranslate"`. Register it after the two existing actions using `createTranslationShortcutSetting` and the shared `claimed` set. Use a Windows guard for registration, not the screen capture capability. Reuse the existing recording suppression and quit cleanup. Add `settings.shortcuts.selectionTranslate` in both locales: **Translate Selection** and **划词翻译**. Keep the existing rows, keys, settings, and default chords.
- [ ] **Green — connect the port:** Export `SelectionTextPort` in `platform/selection-text.ts` with `snapshot`, `isCurrent`, and async `read`, plus a discriminated result whose only text case is `{ status: "selected", text: string }`. Wrap the native module. A failed snapshot gives no target, a failed check means the target is not current, and a rejected read gives `unavailable`. Pass the production port to `createQuickTranslateController` through an optional `selectionText` option. Bind `Alt+D` to `activateSelectionTranslate(): Promise<void>`.
- [ ] **Green — keep one delivery path:** Capture the target and read it before calling `open()`. Recheck the target before opening or focusing, then deliver valid text with `deliverSource(text, "selection")`. Add `selection` to `SourceDeliveryKind`; both selection and clipboard deliveries start collapsed, including on the first mount. Keep OCR expanded. Do not call `activateDoubleCopy`, read the clipboard, or start translation from the shortcut handler. `sourceDelivery.seq` already starts the session's translation action. With no eligible expanded cards, show the selection but do not create a card or send a request.
- [ ] Update the existing shell assertions in `app/quick-translate.test.tsx` for three registrations and releases, and for the new independent third binding in partial-registration scenarios. Keep the old assertions for double-copy, OCR, non-Windows behavior, and the tray.

**Validation:** Run `mise exec -- nsh test app/quick-translate.test.tsx --filter "selection translate:"` before and after the slice. Red fails while waiting for the read to start. Green shows the preview and exactly one request with the complete selection. Run `mise exec -- nsh test app/quick-translate.test.tsx` after updating the shared regression tests.

### 3. Drop stale reads and preserve the draft on failure

**Seam:** Controller lifetime. **Outcome:** Only a current, successful read replaces the draft and starts translation.

**Files:** Modify `app/quick-translate-controller.ts` and `app/quick-translate.test.tsx`.

- [ ] **Red:** Add `selection controller: close while reading does not reopen a closed popup`. Start an activation while the popup is closed, call `close()`, then resolve the deferred port with valid text. Assert that the popup remains closed and that the draft and delivery are unchanged. The basic activation from Task 2 reopens the popup because `close()` can return before invalidating a pending read.
- [ ] **Green:** Invalidate source reads at the start of `close()`, even when the popup is not open yet. `AppShell` uses this method for cleanup too.
- [ ] **Repeat red/green — changed target or draft:** Use the existing draft generation to discard results after an edit, clear, or another delivery. Verify that a manual edit wins against a delayed read. Also test a port that returns selected text but reports that the target is no longer current. Recheck immediately before `open()`; stale results do not open or focus the popup.
- [ ] **Repeat red/green — overlaps:** Use a shared generation for double-copy and selection reads so a newer activation invalidates an older one. The controller keeps at most one running UIA read and one queued target. Capture each target at shortcut dispatch. Replace the queued target on a newer press and clear it on cancellation. Check the request and target again before starting a queued read. Resolve superseded activations without a delivery. Test with a slow first read and two newer presses: one UIA call runs at a time, the middle request is dropped, and only the latest current result delivers. Test in both directions with double-copy: a late selection cannot replace a newer copy, and a late clipboard read cannot replace a newer selection.
- [ ] **Repeat red/green — empty or failed read:** `noSelection`, `unavailable`, blank text, or a rejected port call opens or focuses the existing popup only if the request and target are still current. Keep any draft, pin, and results. Do not bump the delivery sequence or start a request. Test this with an existing draft and with a closed popup.
- [ ] **Repeat red/green — OCR:** Ignore `Alt+D` while the native region overlay is active. Starting OCR invalidates a pending selection read. During recognition, only a valid selection that is delivered first cancels OCR. If OCR delivers first, the draft generation makes the pending selection stale. Test the overlay guard and confirm an empty selection does not abort recognition.

**Validation:** Run `mise exec -- nsh test app/quick-translate.test.tsx --filter "selection controller:"` before and after each case. The first red run reopens the popup; green leaves it closed. Follow-up runs verify the winning delivery and no extra deliveries from failed or stale reads. Re-run `mise exec -- nsh test app/quick-translate.test.tsx` to verify the unchanged double-copy and OCR flows.

## Shortcut Settings Regression

**Seam:** Shortcut settings. **Outcome:** The existing translation bindings keep priority, and the user can change or remove the new binding.

**Files:** Extend `app/quick-translate.test.tsx`, `app/__tests__/quick-translate-harness.tsx`, and `.mise/tests/shortcut-registration.test.ts`. Change `features/settings/shortcuts.ts` or `app/quick-translate.tsx` only if a case exposes a gap. Update `README.md` and `docs/ui/DESIGNE.md`.

- [ ] Add `selection shortcut:` cases to the app harness. Seed `Alt+D` as the saved chord of each existing action in turn. The existing action must retain the binding, the selection row must show the localized inactive state, and pressing the chord must not start a selection read. Extend the existing registration fixture to refuse `ctrl+shift+y` for a replacement. Verify the error, the unchanged storage value, and that the previous selection binding still works.
- [ ] Extend `Windows records and registers independent translation shortcuts` in `.mise/tests/shortcut-registration.test.ts`. Verify the new row shows `Alt+D`, accepts a free replacement such as `Alt+Shift+F7`, and persists it under its own key. Verify Clear persists the empty string and Reset attempts `Alt+D` again. Keep the native checks for Escape, recorder focus, and the other two bindings. If another process owns `Alt+D`, Reset must show an unavailable state and keep the confirmed value.
- [ ] If any case fails, use the failing case for red and fix only its registration or lifecycle gap. Cases that already pass prove the existing settings flow works with the new row; do not change shared code to manufacture a red run.
- [ ] Update the shortcut and Quick Translate entries in the README and design system. Document the address-bar conflict and how to rebind or clear. The new row uses the current recording, clear, reset, and alert states. The popup uses the current collapsed preview and introduces no new motion.

**Validation:** Run `mise exec -- nsh test app/quick-translate.test.tsx --filter "selection shortcut:"` and `mise exec -- nsh test .mise/tests/shortcut-registration.test.ts --target windows --filter "independent translation shortcuts"`. Expect the original actions to retain ownership and the native row to save and release its own binding. Run any failing command again after its fix.

## Final Validation

- [ ] Run `mise run verify`. Expect formatting, lint, type checks, Rust and headless tests, and the build to pass. The interactive native selection tests are ignored in this run by design.
- [ ] Run the interactive Rust command in Task 1 and `mise run test-desktop` on Windows. Headless shortcut tests do not prove that the real foreground focus stays in another process until the read finishes.
- [ ] Run `mise run dev`. Hide the main window and select harmless text in Notepad and at least one of Edge or Chrome, including normal web page text, not only address-bar or input-field text. Press `Alt+D`. Confirm that focus stays at the source until the read completes, the popup opens at the cursor, and one configured expanded preset translates the full selection with Auto-translate off. These are release checks for the core workflow.
- [ ] Try Word, VS Code, a PDF viewer, and a terminal. Record app version, surface, and result. Check no selection, a password field, a fast app switch, a held shortcut, and a pinned popup. Verify no stale popup or request on a focus change, no double trigger from holding the key, and no changes to a known clipboard value. Unsupported surfaces must fail without translating unrelated text.
- [ ] Check the new row in light and dark and at the compact viewport, with `en` and `zh-CN`. Confirm no clipping, clear hover and focus states, keyboard recording and recovery, and unchanged reduced-motion behavior. Check tray, double-copy, and Screenshot Translate still work. With the other bindings at their defaults, clear the selection shortcut and verify that `Alt+D` focuses the address bar again in Edge and File Explorer.

## Failure Behavior

| Condition | Result |
| --- | --- |
| Current target has no nonblank selection, is protected, or its provider cannot answer | Open or focus Quick Translate. Keep the draft and results; do not send a request. |
| Source focus changed, the popup closed, the draft changed, or a newer request won | Drop the result. Do not open, focus, or replace anything. |
| Native OCR region selection is active | Ignore the selection shortcut. Keep the overlay active. |
| Global shortcut registration fails or the chord is claimed by an existing action | Show the existing inactive or conflict message in the row. A rejected change keeps the previous binding. The tray still opens Quick Translate. |
| Not Windows | Do not register or show the new action. Keep existing platform behavior. |

## Privacy and Security

Read only after the explicit shortcut. Do not retain selected text or target handles beyond the in-memory request and existing popup state. Do not log them or add storage, telemetry, clipboard access, input injection, or elevated privileges. The existing configured translation providers receive the text; automatic language detection may send its existing sample to a different configured provider. Skip UIA controls marked as protected; this cannot detect all sensitive text in custom controls.

## Rollout Notes

No migration. Keep existing storage keys and selection settings independent. A missing selection shortcut key uses `Alt+D`; a saved empty value leaves it unassigned. If a saved Open or Screenshot chord already uses the new default, it takes priority. A successful global registration can still take `Alt+D` away from an application-local address-bar shortcut; that is not a registration error.

## Risks and Mitigations

- **UIA provider coverage varies.** Enforce the Notepad and browser release checks, and document unsupported surfaces. Do not add clipboard fallback to make a failed compatibility check pass.
- **Cross-process UIA calls can be slow.** Use an MTA worker, UIA timeouts, a bounded ancestor walk, and one pending replacement. Reject expired results; keep the app responsive if Windows is still returning from a call.
- **The selection is not frozen at keydown.** The target is captured at NSH shortcut dispatch. Before opening, recheck the Win32 foreground and focus; compare the UIA element during the read. A change within the same focused control before the provider answers can still change the selection it returns.

**Open Questions:** No decision blocks implementation. Browser and editor coverage remains unverified until the real Windows checks run.

### References

- Microsoft: [UI Automation threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading), [GetSelection](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextpattern-getselection), [IsPassword](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-automation-element-propids), and [transaction timeouts](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_transactiontimeout).
- Microsoft: [RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey), [Edge commands](https://learn.microsoft.com/en-us/deployedge/edge-learnmore-configurable-edge-commands), and [Windows keyboard shortcuts](https://support.microsoft.com/en-us/windows/keyboard-shortcuts-in-windows-dcc61a57-8ff0-cffe-9796-cb9706c75eec).
