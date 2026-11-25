# Implementation Plan

**Goal:** Highlight a sentence in a live Quick Translate result and its matching source range when the pointer is over the sentence and the source input is expanded.

**Inputs:** The supplied screenshot and the follow-up on Markdown. The screenshot shows a sentence that wraps across lines on both sides. The current implementation is in `src/features/quick-translate/`.

**Assumptions:** Ship on Windows first, for successful forward results in plain text and Markdown. Support Markdown paragraphs, headings, and prose in list items. Keep native links, tables, code blocks, and other unsupported content unchanged. A link label can take the sentence's highlight, but hovering only over a link keeps the native link behavior. History and back-translation do not participate. Use conservative local alignment. Do not guarantee a match for every sentence.

**Architecture:** Translate the whole input as before. After a successful result, build a local map from visible result sentences to ranges in the exact source snapshot. The popup owns one active match. Render its source range as an editor decoration, not as a selection. Use the same map for pointer and keyboard use.

**Tech Stack:** NSH 0.7.0, TSX, the existing `langnext-native` Rust extension, `unicode-segmentation` 1.13.3 (already resolved by the NSH workspace), `nsh/test`, and mise. Do not upgrade NSH or change translation providers.

---

## Interaction Contract

- Highlight the same sentence on both sides with `bg-brand-soft`, distinct from a text selection. Auto-wrap does not divide a sentence. Apply or clear the background immediately, with no layout change, focus move, or automatic scroll. Only one card and one match are active at a time.
- Clear pointer preview on leave, drag selection, or result content scrolling under the pointer. Clear all preview state when the source changes or collapses, the active result changes or disappears, Markdown mode changes, history opens, or the popup hides. Keep the source caret, selection, and IME state intact. Do not preview during composition.
- Do not show an affordance for an unmapped sentence, streaming or partial results, or collapsed source. Do not change raw text sent to providers, copied by the card button, spoken, or saved. Normal drag-to-select and link behavior stay available.

## File Map

- Create `src/features/quick-translate/source-editor.tsx` for the Windows editor adapter and range decorations.
- Create `src/features/quick-translate/aligned-translation.tsx` for alignable spans and `src/features/quick-translate/alignment-document.ts` to map visible Markdown text to inline nodes.
- Modify `src/features/quick-translate/popup.tsx` to connect the editor and own preview state. Modify `src/features/quick-translate/session.ts` to retain the source snapshot of each forward result.
- Modify `src/components/ui/textarea.tsx` and `src/components/ui/font-step.ts` to share font-fit probes without changing the shared field's behavior.
- Modify `src/app/quick-translate.tsx` and `src/app/quick-translate-controller.ts` for scroll and window lifecycle. Use an editor handle for the existing focus and caret commands.
- Create `ext/langnext-native/src/sentence_alignment.rs` for local sentence splitting, alignment, and Rust tests. Modify `ext/langnext-native/src/lib.rs` and `ext/langnext-native/Cargo.toml` to register the method and declare its dependency. Let Cargo update `ext/langnext-native/Cargo.lock`.
- Create `src/features/quick-translate/sentence-highlight.test.tsx` and `src/features/quick-translate/__tests__/sentence-highlight-app.tsx` to test the editor and result components with known ranges.
- Extend `src/features/quick-translate/popup.test.tsx` and `src/features/quick-translate/__tests__/popup-harness.tsx` to test the translation-to-preview flow. Use `src/app/quick-translate.test.tsx` for window and input regressions.
- Modify `DESIGN.md` before UI edits to record motion. Modify `README.md` to document behavior and `locales/en.yml` and `locales/zh-CN.yml` for accessibility labels.

## Seams

- `QuickTranslateSourceEditor` and `AlignedTranslation` through a real NSH window: pointer hit, text wrapping, non-selection decoration, and Markdown marks. Known range fixtures are test-only.
- `SentenceAlignmentNative.align(sourceText, targetBlocks)` and its Rust implementation: immutable input in, half-open UTF-16 range pairs out. `targetBlocks` is an ordered array of visible prose blocks with `null` for a non-prose boundary. Each pair has `sourceStart`, `sourceEnd`, `targetBlockIndex`, `targetStart`, and `targetEnd`.
- `QuickTranslatePopup` through the existing harness: a completed translation enables preview only for its current source and result. Copy, speech, translation, and window commands stay intact.
- A focusable result through the same popup: arrow keys and accessibility actions preview matching sentences without pointer input.

Confirm these seams before writing tests. Follow `/tdd`: run one new test red, implement the smallest behavior that makes it green, then repeat. An import, setup, or type error is not a valid red result.

## Tasks

### 1. Prove the native range highlight

**Seam:** `QuickTranslateSourceEditor` and `AlignedTranslation` in an NSH window.

- [ ] Record immediate background changes and clearing in `DESIGN.md`. Add the test app and a red case named `sentence highlight native:`. Mount a source with a non-empty user selection and a result with two known sentence ranges. Hover the first result span. Check that the matching source range gains a background and the selected text and draft do not change. Move to non-text content and check that the background clears.
- [ ] Implement the editor adapter with `createRichEditor`, a plain paragraph/text schema, and a `RichEditorPlugin`. Use `setDecorations` with `kind: "inline"` and `attrs.class` for the background. Map source offsets to paragraph text positions, not raw document node positions: account for paragraph boundaries, empty lines, and UTF-16 units. If the draft uses CRLF, normalize only the editor projection and map the offsets; keep the submitted draft unchanged until the user edits it. Never call `setTextSelection` to draw preview.
- [ ] In `aligned-translation.tsx`, keep one selectable `Text` flow for the plain result. Use inline `Text` spans with `onMouseEnter` / `onMouseLeave` and a `hover:` class. NSH 0.7.0 only registers a non-pressable inline span for hit testing when it tracks hover. Keep the gap between sentences outside the hover spans. Do not turn text spans into buttons or links. Apply both backgrounds from the same active match.
- [ ] In the next cycle, verify Enter submits once, Shift+Enter inserts a newline, and candidate confirmation with Pinyin or Japanese IME does not translate. Enable `RichEditorPlugin.captureKeys` for Enter and use a Shift+Enter `command("splitBlock")` key binding. Only submit from the current editable session and not during composition. Report source edits only when plain text changes, so a decoration update never schedules translation. Keep undo, plain-text paste, source focus, and read-only OCR behavior. Reuse the existing font-fit scale and verify the source height tracks its content and empty source resets the font step.
- [ ] On Windows, narrow the window so one pair wraps onto at least two lines on both sides. Move over each line of the result. Check both backgrounds, typography in light and dark, drag-to-select and copy, and source caret and selection after leaving. Test a draft with a blank line and an emoji before the match. Use headless `app.spanStyle` for text color assertions where available; use desktop screenshots and direct interaction for native draw and IME checks.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/sentence-highlight.test.tsx --filter 'sentence highlight native:'`. Expect a missing background before implementation, and the matching, clearing, and editing checks to pass after. Use the same command with `--target windows --foreground` for the real window. Do not ship the editor swap if the Windows gate fails. Keep `Textarea`, report the exact failure, and reassess instead of simulating a selection or replacing NSH.

### 2. Align completed text without a new request

**Seam:** `SentenceAlignmentNative.align` and its Rust implementation.

- [ ] In `sentence_alignment.rs`, write a red test for a single English sentence and a Chinese sentence with leading spaces and an emoji before other text in the same sentence. Assert the exact text each returned UTF-16 range selects. Then test blank inputs, `.`, `。`, `！`, quoted punctuation, CRLF and blank lines, and repeated sentence text.
- [ ] Use `UnicodeSegmentation::split_sentence_bound_indices()` for both sides. Preserve exact input coordinates and trim only range edges. Split prose groups at blank lines and at target block edges. For plain text, pass one target block with the full string, so the Rust code can find its blank lines. Treat `null` as a break in target prose, never as a sentence. Bind one source sentence to one target sentence when they are both the sole prose sentence and there is no excluded block.
- [ ] Add one test then implementation per rule for multi-sentence text. A literal anchor is an exact shared ASCII token (letters, digits, and underscores) that contains a digit or consists of at least two uppercase letters. Use a token only if it occurs in one source and one target sentence. A quote anchor is an equal count of at least two paired double quotes, unique to one sentence on each side. Use it only if it preserves the order of at least one accepted literal anchor elsewhere in the result. Recognize straight and curly double-quote pairs. If candidates conflict or invert the order, do not use them to fill gaps.
- [ ] Within a pair of prose groups linked by an accepted anchor, fill a gap only if it has one source and one target sentence and is bounded by two accepted anchors, or by one accepted anchor and both groups' same-side edges. Never fill across groups or match unanchored sentences by ordinal. Test that unanchored equal-count text and unequal gaps stay unpaired. Include both paragraphs from the screenshot: `NSH` and `TSX` anchor the first group; the three quoted choices anchor the last sentence of the second group. Verify that `初始界面包含…外观设置。` maps only to `The initial interface includes…appearance settings.`
- [ ] Export and register `SentenceAlignmentNative.align` in `lib.rs`. Use the existing native module pattern. Return ranges only, not a copy of user text. Run `mise run check` to generate and verify the declarations; do not edit generated files.

**Red/green:** `mise exec -- cargo test --manifest-path ext/langnext-native/Cargo.toml sentence_alignment`. Expect a missing or incorrect pair first, and exact ranges with no forced pairs for ambiguous examples after. In a new Rust module, add its signature and an empty implementation before the red run if needed.

### 3. Connect the live plain-text result

**Seam:** `QuickTranslatePopup` through the popup harness.

- [ ] Add a red case named `sentence highlight live:` in `popup.test.tsx`. Complete a translation with the existing provider boundary, hover the second aligned sentence, and check that only that source range and result sentence get the background. Collapse and expand the source; the preview clears and the next hover works without another translation request. Check that the card still copies its original result.
- [ ] In `session.ts`, include the exact `ActionLanguages.text` snapshot in successful forward card results. Reuse the selected query's result identity. The popup uses the card ID, result identity, and render mode to reject stale events, including when a retry returns the same string. Compute alignment only for eligible, displayed, completed results with a source snapshot that equals the current input. Keep the map with the result and mode in memory; do not recompute when the pointer moves or invalidate maps just because another card gets hover. Keep streaming, errors, history, and back-translation on `TranslationOutput`.
- [ ] Use the Windows adapter from Task 1 for the expanded source on Windows only, independent of result or hover state so publication does not remount it. Keep `Textarea` on other platforms. Replace the `InputRef` requirement in the popup and controller with a structural handle for `focus`, `blur` and `setSelection`. The adapter maps caret positions for those existing calls only. Continue to use the current collapse/expand, clear, and delivery paths.
- [ ] Add red/green cases for a source edit during preview, a retry or template change, moving between cards, and a late completion after close. On span leave, clear only the match that produced the event. Allow a span enter for the same match before the next draw to cancel that clear. Pass a scroll revision from the existing `Scroll.onScroll` and window visibility from the app to clear preview without another scroll container. Test that AI, DeepL, and Google Cloud successes use the same path; no provider contract changes.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter 'sentence highlight live:'`. Expect no synchronized background before the binding, then assert the expected ranges, state clearing, and unchanged request count and copy text.

### 4. Extend the same preview to Markdown

**Seam:** `AlignedTranslation` in the NSH window, then Markdown mode through Quick Translate.

- [ ] Add a red case named `sentence highlight markdown:` in `sentence-highlight.test.tsx`. A paragraph has two sentences, with the first split across plain, **bold**, and _italic_ runs and a native link. Hover a short non-link fragment. Assert that the complete sentence, including its link label, and the source range highlight. Do not highlight the adjacent sentence. Check that formatting and selectable text remain the same.
- [ ] In `alignment-document.ts`, parse completed Markdown once with `TextView.parse(text, { html: false, math: false })`. Walk `TextViewDocument` prose in display order. Concatenate visible text within each eligible paragraph, heading, or prose block in a list item, keeping a UTF-16 range for each eligible inline. Include link labels, not link URLs, in the alignment text. Treat explicit breaks as separators. Leave a block that mixes unsupported inline content, such as an image, unmodified and report it as an alignment boundary. Do not strip Markdown with regular expressions.
- [ ] Pass the annotated `document` to `TextView` instead of its `markdown` prop on the eligible path. Keep normal block nodes and mark wrappers. Split text leaves only at match boundaries. For each annotated run use a custom inline node carrying its text and match ID, and return a nested `Text` span from `renderCustom`. Keep nodes stable on hover and use a reactive background, so no parse, remount, or copy-text change occurs. For runs inside native links, share the active background but do not register a second pointer handler. Preserve `links="report"`, image fallback, native link press and hint, and original card copy behavior. Unhandled content keeps the current renderer.
- [ ] In separate cycles, test a sentence that crosses mark boundaries and wraps, a heading and a list item, and a table and fenced code block next to prose. In `popup.test.tsx`, add a case with the same prefix: change the Markdown setting while a result is active. Assert that mode change clears the old preview, does not translate again, and the newly hovered sentence uses displayed text. Reuse the app test for the real Markdown toggle. If an inline renderer breaks selection or native link semantics, fail this task and narrow its coverage explicitly before shipping.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/sentence-highlight.test.tsx --filter 'sentence highlight markdown:'` and `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter 'sentence highlight markdown:'`. Expect no match across formatting boundaries before the change; afterward the backgrounds, native markup and request count pass. Confirm wrap, tooltip, and drag-to-copy on Windows.

### 5. Expose the same preview to the keyboard

**Seam:** One focus stop in an eligible result card.

- [ ] Add a red case named `sentence highlight keyboard:` in `popup.test.tsx`. Tab to an eligible result, use Right to preview the first and next mapped sentences, use Left to move back, and Tab away to clear. Confirm that the source is never focused and Enter still submits from the source. A result with no matches is not a new stop.
- [ ] Make the eligible result wrapper focusable with a visible focus ring. Capture Left/Right on that wrapper only, without tab stops on individual spans or interception in a nested link. Use the same match state as pointer preview, clear it when focus leaves, and let a new pointer enter take over. Add a localized accessibility name, hint, and Previous/Next actions using the card reorder grip pattern. Report both matched texts when keyboard preview changes, without moving focus. Verify the description update with Narrator; use a polite live region if Narrator does not announce it. Do not announce pointer movement. Add each key to both locale files. Document the scope and keyboard path in `README.md`.

**Red/green:** `mise exec -- nsh test src/features/quick-translate/popup.test.tsx --filter 'sentence highlight keyboard:'`. Expect no keyboard preview before the binding, and correct order, clearing and focus after.

## Final Validation

- `mise run verify`: formatting, lint, checks, full tests, and build pass. Run the exact focused test commands above for each cycle.
- On Windows run `mise exec -- nsh test src/features/quick-translate/sentence-highlight.test.tsx --target windows --foreground`; then use `mise run dev` to verify real IME, source activation and clearing, light and dark appearance, narrow and wide windows, multiple cards, and the screenshot example. Check for stable layout, legible backgrounds, preserved selection and copy, and no added focus or scroll on hover. Check that moving across two adjacent formatted runs in the same sentence does not flash.
- If a test depends on the old field's native test shape, assert draft behavior at the public seam (submitted text, source editing, or copied text). Do not remove the assertion or simulate the editor in production. Record any native check that could not run. Headless success does not replace the Windows gate.

## Failure Behavior

If there is no reliable map, a range cannot be projected, or alignment fails, keep the existing result text and controls without preview. Do not retry translation, add an error label, or let an obsolete preview decorate a newer draft. A failed Windows editor gate blocks shipping both modes, because both need the same source decoration.

## Privacy and Rollout

All alignment runs locally. Do not add requests, logs of source or result text, provider changes, or persistent alignment data. No migration or new setting. Keep other desktop targets on the current source input and output. Unsupported Markdown remains rendered, not converted to plain text.

## Risks and Open Questions

- The Windows source adapter and selection across native Markdown spans need runtime evidence. The design uses current public APIs; it does not presume that platform behavior is correct before the tests run.
- Local rules trade coverage for fewer wrong highlights. If the screenshot and representative English/Chinese results do not align well under these rules, report coverage and get a decision before adding a model, network request, or forced positional match.
- No product decision blocks the plan under the assumptions above. Hover directly on native links and finer-than-sentence alignment are outside this release.
