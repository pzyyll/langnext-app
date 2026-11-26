# Contribution Framework Pre-Acceptance Validation

**Plan:** [2026-11-26-contribution-framework-pre-acceptance-plan.md](./2026-11-26-contribution-framework-pre-acceptance-plan.md)
**Tested commit:** `ff69cfe` (`fix(contributions): close pre-acceptance review findings`)
**Date:** 2026-11-26

The commands below use the paths in the tested commit. See the
[current names](./2026-11-26-contribution-framework-plan.md) for the renamed paths.

## Automated results

| Command | Result |
| --- | --- |
| `mise run verify` | Format, lint, type checks, Rust, 857 headless tests (848 passed, 0 failed, 9 skipped), and release build passed. |
| `mise exec -- nsh test src/features/settings/settings.test.tsx --target windows --filter "capability desktop:"` | 2 passed, 0 failed (22.0 s). |
| `mise exec -- nsh test src/app/quick-translate.test.tsx --target windows --filter "capability desktop:"` | 3 passed, 0 failed (14.1 s). |
| `mise exec -- nsh test src/features/settings/settings.test.tsx` | 77 passed, 0 failed. |
| `mise exec -- nsh test src/features/language-detection/settings.test.ts` | 15 passed, 0 failed. |
| `mise exec -- nsh test src/features/language-detection/detect.test.ts` | 31 passed, 0 failed. |
| `mise exec -- nsh test src/contributions/detect/channels/channels.test.ts` | 13 passed, 0 failed. |
| `mise exec -- nsh test src/contributions/ocr/vendor/baidu.test.ts` | 11 passed, 0 failed. |

## Task coverage

- Task 1: the Baidu token request logs no request or response body; the OCR request keeps its existing body-log policy.
- Task 2: a failed collection load keeps the original bytes and blocks every write until a successful reload; Add is hidden in the header and the empty-state picker.
- Task 3: a failed detection-preferences load shows one error, disables both selectors, and blocks writes.
- Task 4: unreadable credentials cannot enable or be kept; the host shows one localized recovery alert; a readable replacement recovers the channel.
- Task 5: Save availability matches the pre-migration rules for AI, Baidu, Vision, Cloud detection, Google TTS, and Azure TTS.
- Task 6: previews require a readable saved key; Azure previews use only the saved region; editing and Save lock while a preview is loading or playing, and Cancel unlocks them.
- Task 7: the free Google row is static identity content, and its Remove control takes focus after a picker or empty-state add; cancelling removal keeps the row.
- Task 8: OCR and detection assembly reject a duplicate channel id at startup.
- Task 9: free Google and Google Cloud detection use the injected host fetch and credential seams.
- Task 10: the two Windows commands above pass and exercise add, save, enable, priority badges, drag reorder, breadcrumb return, confirmed removal, the free Google row, one unreadable alert, OCR fallback, automatic detection, and a held TTS request with Cancel.

## Manual review

The Windows acceptance cases drive the real window with seeded storage. They cover the manual add, save, enable, priority, drag reorder, breadcrumb, remove, free-row focus, unreadable-alert, OCR fallback, automatic detection, and TTS request/Cancel checks.

Not run: audible TTS sample playback with a valid MP3 response or an approved test credential. No approved test credential is available, and the development app would use production data. Native playback therefore remains unverified manually. Keyboard reorder is covered by the existing headless test `ocr settings: the grip reorders channels with the arrow keys and keeps the focus`; the new Windows Settings case covers drag reorder.

The `error invalid op: UnknownNode(570)` line after cancelling a loading TTS request on window close is pre-existing; it also appears in the existing headless close test.
