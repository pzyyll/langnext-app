# Implementation Plan

**Goal:** Bring the LangNext quick translate popup to My Translator on Windows without changing the main workspace.

**Inputs:** `F:/workspace/my/langnext-app` at `8513cb4`: `src/routes/quick-translate.tsx`, `src-tauri/src/windows/quick_translate.rs`, `src-tauri/src/shortcuts.rs`, and `src/features/translate/quickTranslateSession.ts`. In this repo: `docs/specs/system-architecture.md`, `docs/ui/DESIGNE.md`, and the existing Models, Presets, and AI modules. Use the source code when its behavior differs from the old LangNext plan.

**Assumptions:** Windows is the first verified target. Stage 1 uses completed plain-text responses from the four registered AI protocols. Stage 2 adds multiple results and double-copy input. Unlike LangNext, automatic translation and double-copy input are off until the user enables them. Confirm these rollout choices and the test interfaces below before implementation.

**Architecture:** Keep one NSH app and one window ID, `quick-translate`. The shell owns activation. The popup owns text and request lifetimes, while the saved Models and Presets stores remain the source of configuration. Use the NSH window, shortcut, and clipboard APIs; use a Windows-only Rust extension for cursor data and non-consuming double-copy detection.

**Tech Stack:** NSH Mixed `0.6.0`, TSX, Rust, mise, `nsh/test`, Cargo, and Win32.

---

## Scope

| Area | Stage 1: Translate in a popup | Stage 2: Match the shortcut workflow |
| --- | --- | --- |
| Activation | `Ctrl+Shift+T` and a tray menu item. Neither reads the clipboard. | Optional double `Ctrl+C` within 400 ms. Copy still works normally. Read plain text and put it in the source field. |
| Window | A single floating window. Input focus on open, pin to keep it open, close on focus loss when unpinned, close with `Esc` or the close button. | Anchor a new window to the cursor on its display. Keep it in the work area. Reuse and focus an open window without moving it. |
| Text and results | Edit or paste, clear, choose source and target, use one enabled saved preset, translate by button or Enter in manual mode, and copy the result. Optional 500 ms automatic translation. | Multiple result cards, per-card preset and template selection, collapse, retry or retranslate, copy, and remove. Remember only preferences. |

Not in this plan: screenshot capture or OCR, selection APIs, mouse-move dismissal, a global mouse hook, Markdown, streamed output, a separate language-detection request, auto-growing window height, custom shortcut bindings, history, or macOS/Linux support claims. Do not port React, Tauri events, browser storage, or the LangNext plugin runtime. Do not add a Sidebar destination.

## File map

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `modules/ai/contracts/protocol.ts`, `modules/ai/runtime/{http,client}.ts` | Text-generation contract, JSON POST, routing, cancellation, and sanitized failures. |
| Modify | `modules/ai/protocols/{openai-chat,openai-responses,anthropic,gemini}/index.ts` | Protocol-specific request bodies and text extraction. |
| Test | `modules/ai/runtime/client.test.ts`, `modules/ai/protocols/protocols.test.ts` | Generated requests and responses through public AI interfaces. |
| Modify | `features/models/store.ts` | Build an immutable request snapshot for an eligible saved model; resolve its credential through the existing path. |
| Create/test | `features/quick-translate/translate.ts`, `features/quick-translate/translate.test.ts` | Render preset templates, resolve language choices, and run the model chain. |
| Create/test | `app/quick-translate.tsx`, `app/quick-translate.test.tsx` | Shortcut/tray activation and native window lifecycle. |
| Modify | `app/shell.tsx`, `App.tsx`, `features/presets/page.tsx` | Install activation once; share startup loading of saved presets without a second reload on navigation. Keep explicit retry. |
| Create/test | `features/quick-translate/popup.tsx`, `features/quick-translate/popup.test.tsx` | Source controls, result cards, cancellation, and input behavior. |
| Create/test | `features/quick-translate/preferences.ts`, `features/quick-translate/preferences.test.ts` | Versioned preferences, validation, and write recovery. |
| Create/test | `platform/quick-translate.ts`, `platform/quick-translate.test.ts` | Use NSH desktop APIs and convert cursor measurements to window placement. |
| Modify/create | `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/quick_translate.rs` | Typed, Windows-only cursor and double-copy operations. Keep non-Windows entry points inert. |
| Test | `tests/quick_translate_input.rs` | Double-copy recognition through the same input interface used by Windows. |
| Modify | `features/settings/page.tsx`, `features/settings/settings.test.tsx` | Windows-only double-copy opt-in and failure feedback. |
| Modify | `components/ui/textarea.tsx`, `locales/{en,zh-CN}.yml`, `docs/ui/DESIGNE.md`, `README.md` | Submit behavior, localized copy, design and motion inventory, and user instructions. |

## Seams

- **AI:** `createAiClient(...).generateText(...)` and the registered protocols, observed at the HTTP boundary.
- **Preset execution:** proposed `translateWithPreset(input, dependencies)`, observed through the generated result and the ordered model requests.
- **Window:** the tray action or registered shortcut callback → `app.window("quick-translate")` and visible controls. Stub only the OS binding in headless tests if necessary. Use the real NSH window in these tests.
- **Popup:** source, language, preset, translate, copy, and result-card controls. Stub the provider and clipboard boundary, not internal signals.
- **Placement:** proposed `resolvePopupPlacement(anchor, displays, size)`, observed as the display and window bounds it returns.
- **Double copy:** native input recognition → a single activation; Settings and activation → the popup source field. Windows desktop checks prove that normal copy still works.
- **Preferences:** proposed `createQuickTranslatePreferences(storage)`, observed through a save/load round trip and the popup after reopening.

## Tasks

Run all commands from the repo root with the mise toolchain. For each named test or manual check below, run it before the change and again after it. The first run must fail for the missing behavior, not for a missing file, selector typo, or unrelated baseline failure. Define the public interface with a minimal stub if needed to make the test runnable. Add one failing case at a time. Do not add test controls to the packaged app.

### Stage 1

#### 1. Send and read a text-generation request

**Seam:** AI. **Files:** AI contracts, HTTP/client files, protocol implementations, and AI tests in the file map.

- [ ] **Red:** Add `text generation:` cases. Start with Chat Completions: fixture text `Bonjour` must appear in the return value, and the captured request must be `POST` to the existing model target with the expected model, system prompt, and user prompt. Repeat one case at a time for Responses, Messages, and Gemini.
- [ ] **Green:** Add `AiClient.generateText(connection, { modelId, system, user, temperature, maxOutputTokens }, options)` returning `Promise<string>`. Add `JsonHttpClient.postJson` and a protocol generation operation that reuses the existing `{ kind: "model", modelId }` route. Preserve the provider's root policy, credential header, and model API override. Request non-streaming output. Do not change catalog behavior.
- [ ] Use Chat `messages` / `choices[].message.content`, Responses `instructions` and `input` / message `output_text` parts, Anthropic `system` and `messages` / `content` text blocks, and Gemini `systemInstruction` and `contents` / first candidate's text parts. For Chat, use `max_completion_tokens`; for Responses, `max_output_tokens`; for Messages, `max_tokens` with a named default of 1,024 when unset; for Gemini, `generationConfig.maxOutputTokens`. Omit unset temperature and other optional fields. If a model rejects a configured parameter, surface failure; do not silently change the preset. Test multi-part output, excluding reasoning or tool blocks, and missing/blank text as `invalid_response`.
- [ ] Keep abort and timeout active through response parsing. Test abort during a slow body, JSON rejection, HTTP 401, and HTTP 429. Requests that carry source text must not follow redirects; use `redirect: "error"` and confirm the NSH runtime rejects a redirect in a loopback test. Use error categories for UI copy, not raw bodies, URLs, or tokens.

**Red → green:** `mise exec -- nsh test modules/ai/runtime/client.test.ts --filter "text generation:"` and `mise exec -- nsh test modules/ai/protocols/protocols.test.ts --filter "text generation:"`. Expected: a failing return value or request assertion first; afterward all four cases and the error/cancellation cases pass.

#### 2. Execute a saved preset

**Seam:** Preset execution. **Files:** `features/models/store.ts`, `features/quick-translate/translate.ts`, `features/quick-translate/translate.test.ts`.

- [ ] **Red:** Given a saved preset and `Hello {{target_language}}`, assert one request with the correct system and user prompts, the source braces left literal, and the model key rather than the saved model UUID. Add cases for source `auto`, a chosen target, unsupported models, and an aborted primary request.
- [ ] **Green:** Expose a read-only `resolveSavedModelRequest(modelId)` in the Models store. Reuse existing model capability and effective protocol helpers and the saved credential lookup; do not copy secret storage logic into the feature. Skip missing, disabled, unsupported, or non-text models and disabled channels. Enforce saved HTTP consent for non-loopback endpoints on each attempt. Resolve configuration and the credential when needed, not when opening the popup.
- [ ] Initialize the language fields from the selected preset (`null` target becomes `zh`). After a user changes a field, that selection governs until they change presets in Stage 1. Give the model the language names by `getLanguageLabel` for concrete IDs; in `auto` pass a localized instruction to detect the source in the same request. Render `{{source_language}}`, `{{target_language}}`, and `{{text}}` in one pass using the preset's default template; never evaluate the input as template code. Reject blank source, missing default templates, and disabled presets without a request.
- [ ] Attempt the saved chain in order. Continue on an unavailable model, timeout, network error, 429, or 5xx. Stop on cancellation, authentication, other 4xx, invalid response, or success. Return the chosen model ID and the text. Test `unavailable primary → 429 → success` and `401 → no next request`. If no attempt succeeds, return one localized actionable failure.

**Red → green:** `mise exec -- nsh test features/quick-translate/translate.test.ts --filter "preset translation:"`. Expected: prompt and model order are initially wrong or absent; then the exact prompts, routes, and counts pass.

#### 3. Open and close one native window

**Seam:** Window. **Files:** `app/quick-translate.tsx`, `app/quick-translate.test.tsx`, `app/shell.tsx`, `locales/{en,zh-CN}.yml`, `docs/ui/DESIGNE.md`.

- [ ] **Red:** Invoke the production tray action from a test fixture and check `app.window("quick-translate").state()` changes from `null` to visible. Invoke again and check the same window and active source value. Check blur when unpinned, survival when pinned, and close even when pinned.
- [ ] **Green:** Add a controlled `<Window>` with `id="quick-translate"`, floating level and no taskbar entry. Open centered on the main window's display in Stage 1. Close on native focus loss only when not pinned. Reset pin on close. Ensure close button, Escape, and OS close all go through one cleanup path, without quitting the app. Keep the app available while the main window is hidden, leave tray primary click as-is, and do not change main navigation.
- [ ] Register `GlobalShortcut.register("ctrl+shift+t", open)` once, only on Windows. Unregister on shell disposal or quit. If registration returns `false` or rejects, keep the tray action and show a localized warning. Keep registration outside any locale-change effect. Verify that a popup select/menu does not trigger a false blur dismissal and that Escape dismisses the menu before the window.
- [ ] Before writing the screen, add its motion inventory to `docs/ui/DESIGNE.md`: native show/close, shared hover/press/focus, select overlay, and result/loading changes. Use shared motion tokens and the reduced-motion behavior. Specify a compact window, initially `420 × 360` points, with one scroll owner for long content. Add no hard-coded presentation colors.

**Red → green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick window:"`. Expected: no secondary window or incorrect native state first; then correct reuse, pin, close, and shortcut-error handling. Verify focus, blur, tray and Escape on Windows as well; headless does not prove OS behavior.

#### 4. Translate and copy from the popup

**Seam:** Popup. **Files:** `features/quick-translate/{popup.tsx,popup.test.tsx}`, `App.tsx`, `features/presets/page.tsx`, `components/ui/textarea.tsx`, `locales/{en,zh-CN}.yml`.

- [ ] **Red:** From the popup edit or paste `Hello`, press Enter in manual mode, see `Bonjour`, then press Copy and verify the clipboard value. Test Shift+Enter adds a newline without submitting. Test empty and whitespace-only input, no enabled preset, preset load error, and a clipboard write error.
- [ ] **Green:** Load the shared `presetsStore` on app startup. Show distinct loading, load error with Retry, and no-enabled-preset states. Do not invoke the provider until the user selects an enabled saved preset and there is non-blank text. Compose shared `Textarea`, `Select`, `Button`, and `Card` controls and use `Clipboard.writeText`. Extend `Textarea` with optional `submitBehavior` and `onSubmit`; keep the default `newline` for other callers. Give the native source input focus on open. Give every control a localized label and visible keyboard focus.
- [ ] Add an opt-in automatic mode. While enabled, changes to source text or language run after 500 ms. Changing the preset alone does not send existing text without a Translate action. Enter inserts a newline; the Translate button bypasses the timer. While off, Enter submits and Shift+Enter inserts a newline. Do not submit while an IME is still composing. For the first stage the setting lasts only for the app session.
- [ ] Use `AbortController` and a monotonically increasing request identity. New input, language/preset change, clear, or close invalidates the previous result. Close clears text, results, and pending timers, even if a provider completes later. Unit-test out-of-order completion with deferred promises; test debounce with the NSH manual clock. A new run must not show an old result as current. Copy is available only for a successful current result.

**Red → green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "quick popup:"`. Expected: no new result, wrong clipboard, duplicate call, or stale update before the corresponding change; afterward the visible result and call counts match. Stage 1 is complete after the fixed shortcut works from another app with a saved preset.

### Stage 2

#### 5. Place the window at the cursor

**Seam:** Placement. **Files:** `platform/quick-translate.ts`, `platform/quick-translate.test.ts`, `app/quick-translate.tsx`, `src/quick_translate.rs`, `src/lib.rs`, `Cargo.toml`, `Cargo.lock`.

- [ ] **Red:** For a display with work area `{ x: -1280, y: -120, width: 1280, height: 984 }`, a `420 × 360` frame, and a cursor at `(-5, 860)` in display points, expect origin `(-420, 504)`. Add a left/top case, mixed-scale case, oversized viewport case, and missing cursor case.
- [ ] **Green:** Use a target-specific `windows-sys` dependency and a typed `QuickTranslateNative.cursorAnchor()` export. On Windows use `GetCursorPos`, `MonitorFromPoint`, and `GetMonitorInfoW` with `MONITORINFOEXW`. Use the same monitor key as [NSH 0.6.0 Win32](https://github.com/longbridge/nsh/blob/v0.6.0/crates/nsh-platform-windows/src/window_state/screens.rs): the device interface name from `EnumDisplayDevicesW`, or `szDevice` if unavailable. Convert it with `nsh_core::desktop::DisplayId::from_name`. Return the display ID and the cursor's physical offset from `rcMonitor` (other targets return null). Match `displays()` by ID. Add the offset divided by that display's `scaleFactor` to its point origin. Use `visibleBounds` for the clamp. Do not divide a global pixel origin by one scale factor. If the display or its scale is unavailable, use Stage 1 centering. Verify the mapping on mixed-DPI monitors.
- [ ] Offset the top edge by 24 points and center horizontally at the cursor, then clamp both axes to the work area. Cap the requested size at the work area when smaller than the normal frame. Pass the display and initial position at creation, and verify the reported bounds after mount. If the platform changes the frame, correct its placement once via `WindowRef.setBounds`. Do not reposition after the user moves the open popup.

**Red → green:** `mise exec -- nsh test platform/quick-translate.test.ts --filter "quick placement:"`. Expected: incorrect display or bounds first; then the position checks pass. Treat unknown monitor matching or incorrect mixed-DPI placement as a release blocker for this task. The centered window remains usable.

#### 6. Accept a double copy without intercepting normal copy

**Seam:** Double copy. **Files:** `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/quick_translate.rs`, `tests/quick_translate_input.rs`, `platform/quick-translate.ts`, `app/quick-translate.{tsx,test.tsx}`, `features/settings/{page.tsx,settings.test.tsx}`, `features/quick-translate/preferences.ts`, `locales/{en,zh-CN}.yml`.

- [ ] **Red:** Feed two distinct Ctrl+C presses less than 400 ms apart into the native recognizer and expect one activation. Check a single press, 401 ms, C hold/repeat, intervening non-copy chords, modifier combinations, and reset on stop. From the shell activation seam, test one clipboard read, delivery to a newly mounted popup, no read when disabled, no new result on empty text, and a slow read superseded by a newer activation or a manual edit.
- [ ] **Green:** Use Windows Raw Input on a worker with keyboard-only `RIDEV_INPUTSINK`, not `RegisterHotKey` on `Ctrl+C`. Accept distinct press/release cycles; do not consume or synthesize keys. Track only the chord and elapsed time. Use a bounded latest-only signal to the NSH engine; post the TS callback on the engine thread. Declare proposed `QuickTranslateNative.onDoubleCopy(listener)` using NSH's typed `Callback` and `Stop`. Check worker registration before reporting enabled. Release the listener and worker on disable, shutdown, or reload. Do not capture mouse events or persist key events.
- [ ] Add the Windows-only opt-in to Settings General. Keep it off by default. Explain that this reads the copied text and that automatic translation can send it to the selected service. If startup or enable fails, keep the listener inactive and show a localized error. Load the stored setting once before registering. Use the versioned preferences module from the start; expand its schema in Task 8.
- [ ] Read with `Clipboard.readText()` in TS only after a double-copy activation. Allow the foreground copy to settle: record `GetClipboardSequenceNumber` at each chord start, and wait off the engine thread up to 150 ms for an update after the second press. If unchanged, still accept text from the first copy if the sequence changed during this pair. Pass only a valid-copy flag to TS, never the clipboard contents or key events from Rust. When no update can be observed, open an editable popup and leave existing input unchanged rather than importing old clipboard data. Empty, non-text, or inaccessible clipboard behaves the same. Deliver only to the current open/copy generation. Do not refocus or replace the draft if the read completes after close, a later activation, or a manual edit. Automatic mode follows the same debounce as a normal paste. Manual mode never sends a request on double copy alone.

**Red → green:** `mise exec -- cargo test --test quick_translate_input`, `mise exec -- nsh test app/quick-translate.test.tsx --filter "double copy:"`, and `mise exec -- nsh test features/settings/settings.test.tsx --filter "double copy:"`. Expected: missing activation, incorrect source field, or wrong registration before the change; afterward one activation per valid pair, no effect when disabled, and no stale delivery. Confirm with Notepad and a browser on Windows, including slow-copy and no-selection cases.

#### 7. Run multiple preset cards independently

**Seam:** Popup and preset execution. **Files:** `features/quick-translate/{popup.tsx,popup.test.tsx,translate.ts,translate.test.ts}`, `locales/{en,zh-CN}.yml`, `docs/ui/DESIGNE.md`.

- [ ] **Red:** Use two cards with stable card IDs, including two instances of the same preset. Give them different templates. Let one succeed and one fail or resolve late after removal. Verify copy, retry, collapse and remove affect only that card. Verify adding or changing a card does not resend text to other cards.
- [ ] **Green:** Allow Add preset, select only enabled saved presets, and allow an optional template override per card. Reuse one shared source and language selection after the initial preset seeds the controls. On a shared input change, invalidate each card and schedule only eligible cards. Give each card its own abort controller and request identity. Keep order independent of completion order. On Add, template change, or Retry, run only that card when applicable (in manual mode Add and template change do not send until Translate or Retry). A collapsed card keeps its result and can expand again. Reuse list/scroll and keyboard behavior; update the design motion inventory before implementing the cards.

**Red → green:** `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "preset cards:"` and `mise exec -- nsh test features/quick-translate/translate.test.ts --filter "template override:"`. Expected: absent second card or shared state before the change; afterward independent results and no cross-card requests or stale updates.

#### 8. Restore preferences and document the workflow

**Seam:** Preferences. **Files:** `features/quick-translate/{preferences.ts,preferences.test.ts,popup.tsx,popup.test.tsx}`, `App.tsx`, `README.md`, `docs/ui/DESIGNE.md`.

- [ ] **Red:** Reopen with saved language, automatic mode, and two cards with different templates. Remove or disable one preset and remove the other card's override template. Reopen and verify only valid cards and settings return, source and result are blank, and no request starts. Check corrupt or unreadable storage, and assert that a stored payload has no input, result, or credential.
- [ ] **Green:** Use NSH `Storage` at `quickTranslate.preferences.v1`. Store source/target language IDs, auto mode, double-copy opt-in, and ordered `{ id, presetId, templateId, collapsed }` cards. Do not filter against the preset store before it finishes loading. Drop missing/disabled presets after a successful load and use the preset's default if an override is gone. Validate at load and serialize writes so late completion cannot revert a newer setting. On unreadable settings, retain defaults and permit a new explicit save. If an explicit setting write fails, show a localized error and do not claim it was saved. Do not store pin state, text, responses, or errors.
- [ ] Document both activation paths, Windows support, opt-in defaults, data destinations, and recovery from a shortcut conflict. Add bilingual visible strings and labels; follow the existing interface copy rules.

**Red → green:** `mise exec -- nsh test features/quick-translate/preferences.test.ts --filter "quick preferences:"` and `mise exec -- nsh test features/quick-translate/popup.test.tsx --filter "quick reopen:"`. Expected: lost preferences or restored content first; afterward only valid preferences restore, with no network call.

## Final validation

1. At each stage boundary run `mise run verify`. Expect formatting, lint, type checks, the full headless suite, and a release bundle to pass. No real API keys in automated tests.
2. Mark tests that use real windows without module stubs or a manual clock with a `desktop:` name prefix. Run `mise exec -- nsh test app/quick-translate.test.tsx --target windows --filter "desktop:"` and `mise exec -- nsh test features/quick-translate/popup.test.tsx --target windows --filter "desktop:"`. Expect at least one passing test per file. Run tests that need headless clipboard inspection, stubs, or the manual clock in step 1.
3. Run `mise run dev -- --target windows`. Configure a disposable test preset against a real provider or a local model. From Notepad with the main window hidden, use `Ctrl+Shift+T`, enter text, translate, and copy. Repeat activation while the window is open. Try clicking another app pinned and unpinned, `Esc`, explicit close, and tray Exit. The main workspace and unsaved editor state must not change. Check registration conflict recovery with the tray.
4. In Stage 2, check 100% and 150% displays, including a display left of or above the primary. Trigger near each edge and the taskbar. Single Ctrl+C and held C must never open the popup; double Ctrl+C in Notepad and a browser must copy the new text and open exactly one popup. Check behavior with empty/non-text clipboard, a slow copy, and a clipboard value left over after copying nothing. Disable the feature and confirm the listener is gone.
5. Check light/dark, English/Simplified Chinese, reduced motion, long multiline text, keyboard focus/Tab/Enter/Escape, and Narrator names. Capture screenshots of the compact popup, an error, and a multi-card result. Report design checklist groups (radius, type, spacing, alignment, color, hover, press, states, and motion) against `docs/ui/DESIGNE.md`. No OS feature is complete on headless evidence alone.
6. Run `mise run package -- --target windows`. Smoke-test the packaged build's tray and fixed shortcut; in Stage 2 also test double copy and runtime cleanup. Packaging is local; do not sign or publish.

## Failure behavior, privacy, and rollout

- An unavailable shortcut must not prevent startup. An unavailable cursor position must not prevent translation. No configured preset, read error, or no eligible model must not send text. No background clipboard monitoring.
- Clipboard text enters memory only on explicit paste or an enabled double-copy gesture. Only a Translate action or the user's enabled automatic mode sends it. Requests go to the saved channels of the selected preset and its eligible fallbacks only. Keep source, result, prompts, raw provider responses, and credentials out of logs and quick-translate storage. Do not change the existing credential storage scheme in this work.
- Ship Stage 1 independently if the Windows cursor or clipboard timing checks fail. Do not claim Stage 2 support until packaged Windows tests pass. Stage 2 adds one app-owned preferences key; do not import LangNext preferences or touch existing Models/Presets data.
- Main risks: treating NSH points as physical pixels, losing or replacing the first clipboard input before the window mounts, and accepting a stale provider result after close. Gate these with the mixed-DPI, asynchronous activation, and cancellation checks above.

**Open questions:** No decision blocks this plan. The Windows-first scope and Stage 2 defaults are proposals for implementation. The Windows NSH coordinate conversion and clipboard timing require real-device validation.
