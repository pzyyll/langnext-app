# Implementation Plan

**Goal:** Configure Anki from the main sidebar and add the source text and translation from one Quick Translate result card to a chosen Anki deck.

**Inputs:** The Wordbook feature request, the decision to ship Anki only, the [AnkiConnect API v1 reference][api], and the [Anki manual on duplicate checks][duplicates].

**Assumptions:**

- Keep the requested top-level sidebar entry: **Wordbook** / **生词本**. Its page configures Anki. It does not show a list of saved notes. Show only Anki, with one saved destination and one enable switch. Default to off.
- Use Anki Desktop with a current [AnkiConnect add-on][addon] that implements API v1. Use release `26.11.22.0` as the contract and first test baseline. Verify the actual Anki Desktop version with this release on Windows. Do not implement legacy v6 or write to AnkiWeb directly.
- Accept words, phrases, and sentences without extracting terms from the source. Only new forward results in Quick Translate can be added. Exclude restored history, back-translation, Eudic, other destinations, offline queues, bulk adds, remote endpoints, and note editing or removal.

**Architecture:** The Wordbook store owns the saved target and enable state. The settings page uses read-only AnkiConnect calls to discover the active profile, decks, note types, and fields. On a card press, the translation session takes the selected result and its original input, and the Anki client checks the saved target before making one `notes.create` call.

**Tech Stack:** TypeScript and TSX, NSH 0.6.1, NSH Storage, `createHttpFetch`, AnkiConnect JSON-RPC 2.0, `nsh/test`, and mise. No new runtime dependencies, Rust code, or database migrations.

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `services/http.ts`, `services/http.test.ts` | Let callers omit request and response bodies from logs without changing the default. |
| Create and test | `features/wordbook/anki-client.ts`, `features/wordbook/anki-client.test.ts` | Discover and check the Anki target, serialize one note, and classify responses at the HTTP boundary. |
| Create and test | `features/wordbook/settings.ts`, `features/wordbook/settings.test.ts` | Load and save the Anki binding, its optional key reference, and enable state. |
| Create | `features/wordbook/page.tsx` | Show the connection check, target and field choices, Save, and the enable switch. |
| Modify | `App.tsx`, `app/shell.tsx`, `components/sidebar.tsx` | Load Wordbook settings, add the sidebar route, and reuse the existing navigation guard and `PageSurface` column layout. |
| Modify | `features/quick-translate/session.ts`, `features/quick-translate/popup.tsx`, `app/quick-translate.tsx` | Add an action for the selected result, with progress and feedback in the same card. Wire the shared store and Anki client at the window entry point. |
| Create and modify | `assets/icons/mdi--book-open-variant.svg`, `assets/icons/mdi--bookmark-plus-outline.svg`, `components/ui/icon.tsx` | Add the Material Design Icons for the sidebar and the result action. Reuse the existing check glyph for success. |
| Test | `app/quick-translate.test.tsx`, `app/__tests__/quick-translate-harness.tsx` | Exercise the sidebar, configuration, and result action through the real shell. Load the store at harness start; use NSH Storage and HTTP fixtures. |
| Modify | `locales/en.yml`, `locales/zh-CN.yml`, `DESIGN.md`, `README.md` | Add localized strings, record motion before TSX changes, and document setup and release limits. |

## Seams

- `createHttpFetch({ logBodies: false, fetchImpl })`: callers can read the response, but payloads do not reach debug logs.
- `createAnkiClient({ fetchImpl })`: `discover`, `getNoteType`, and `addTranslation` report typed outcomes at the external HTTP boundary.
- `createWordbookSettingsStore(storage)`: `load`, `save`, `setEnabled`, and `activeBinding` expose only saved, valid configuration to the popup.
- Main sidebar through `AppShell`: a user can open Wordbook, test the connection, select a target, and save and enable it.
- Quick Translate through `AppShell`: an explicit press on a complete forward result adds the correct pair to the saved target and shows the write outcome.

Confirm these seams before writing tests. For each cycle, add one behavior test, run the stated command, and observe the expected assertion fail. Implement only that behavior and run the same command again. An import or type error is not a valid red result. Use HTTP and Storage fixtures only in tests.

## Tasks

### 1. Keep Anki payloads out of HTTP logs

**Seam:** `createHttpFetch({ logBodies: false, fetchImpl })`.

- [ ] **Red:** Add `http transport: omits bodies when requested` to `services/http.test.ts`. Read a fixture response. Expect the request and status lines, no payload debug lines, and unchanged JSON for the caller.
- [ ] **Green:** Add `logBodies?: boolean` to `CreateHttpFetchOptions` in `services/http.ts`, defaulting to true. When false, omit the request body from the log and return the real response without the body watcher. Keep existing status and failure behavior. The Anki client will also use existing `logFailures: false` so raw transport errors do not reach the log.
- [ ] **Red/green:** `mise exec -- nsh test services/http.test.ts --filter "http transport:"`. Expect the new debug-log assertion to fail first and then pass. Existing transport tests must still pass.

### 2. Inspect the active Anki collection

**Seam:** `createAnkiClient({ fetchImpl }).discover()` and `.getNoteType()`.

- [ ] **Red:** In `features/wordbook/anki-client.test.ts`, return a profile, one normal deck, one filtered deck, and note type summaries with string IDs. Expect the profile and session, only the normal deck, and all note type summaries. In the next cycle, select a non-English note type and expect its ordered field names.
- [ ] **Green:** In `features/wordbook/anki-client.ts`, use `createHttpFetch({ scope: "wordbook/anki", logBodies: false, logFailures: false, fetchImpl })`. POST JSON-RPC 2.0 with `Content-Type: application/json`, a request ID, and `redirect: "error"` to the fixed `http://127.0.0.1:8765/api/v1`. If configured, send the key as `Authorization: Bearer <key>`. Do not set a browser `Origin` header. Check HTTP status before JSON. Require a matching RPC ID, exactly one of `result` or `error`, and the expected shape for the method. Use a 5-second deadline per request, including the response read.
- [ ] **Green:** Call `collection.get` for `{ profile, session }`. Use the session for `decks.list` and `noteTypes.list`; the latter returns summaries only. For a selected type, call `noteTypes.get` with `{ noteType: { id }, session }` to read ordered `fields[].name` and `templates`. Keep IDs as decimal strings. A connection check never sends translation text or writes to Anki.
- [ ] **Next cycles:** Cover refused connection, HTTP 401 and 403, a legacy or unavailable v1 endpoint, no open collection, `staleSession`, malformed replies, and a timeout while reading JSON. Map structured errors to the failure table below. Ignore superseded discovery results in the page, not in the RPC contract.
- [ ] **Red/green:** `mise exec -- nsh test features/wordbook/anki-client.test.ts --filter "anki read:"`. Expect the new discovery, field, or error assertion to fail first and then pass.

### 3. Create one note without overwriting an existing note

**Seam:** `createAnkiClient({ fetchImpl }).addTranslation()`.

- [ ] **Red:** In `features/wordbook/anki-client.test.ts`, use a configured profile, deck, and type with custom field names. Send `A < B\nC & D` and a two-line translation. Expect one `notes.create` request with the mapped fields, line breaks, the same checked session, and the duplicate policy below. Return a valid `noteId` and `cardIds`; expect `added` only after that reply.
- [ ] **Green:** Take an immutable binding and `{ sourceText, translatedText }`. Reject a blank pair without a request. Get the current collection and require its profile name to match the saved name. Resolve the saved deck and note type by ID with `decks.get` and `noteTypes.get` and pass the session to both. Reject a missing or filtered deck or an incompatible type or field mapping. Never fall back to a different profile, deck, or type. Immediately before the write, check that the caller's saved binding is still current and enabled. Pass the same session to the write so an Anki profile switch after the reads fails closed.
- [ ] **Green:** A compatible type is `normal`, has at least two fields and at least one card template, and has no template deck override. The first field is the source field; the translation uses a different existing field. Leave other fields blank. The Anki templates control the final card layout. Convert each value to HTML-safe plain text: escape literal HTML and preserve line breaks with `<br>`. Do not render Markdown or send media. Use top-level `notes.create` params `deck: { id }`, `noteType: { id }`, `fields`, `session`, and `duplicates: { allow: false, scope: "deck", deck: { id }, includeChildren: false, acrossNoteTypes: false }`. Leave Anki's `rejectEmptyQuestions` check on. A success response must contain a valid note ID and at least one valid card ID.
- [ ] **Next cycles:** Verify `validationFailed` with `error.data.details.issues[].type === "duplicate"` maps to `duplicate`, not `added`, and sends no update. Use the tagged [service][service] and [RPC error serialization][protocol] to build the fixture. Do not use a separate duplicate search before the write. Verify no write on profile mismatch, a missing field, a template override, or disable during preflight. Verify a lost, malformed, or timed-out create reply returns `unconfirmed` without a retry. Treat an unexpected create-side internal error as unconfirmed too. Check that read failure and write uncertainty have different recovery text.
- [ ] **Red/green:** `mise exec -- nsh test features/wordbook/anki-client.test.ts --filter "anki add:"`. Expect the new note payload or outcome assertion to fail first and then pass.

### 4. Keep one saved Anki binding

**Seam:** `createWordbookSettingsStore(storage)`.

- [ ] **Red:** In `features/wordbook/settings.test.ts`, start with empty Storage. Expect no active binding. Save a complete target, then enable it and reload in a fresh store. Expect the same active target. Disable and reload; expect the target to remain available for editing, but no active binding.
- [ ] **Green:** In `features/wordbook/settings.ts`, store a versioned binding under `settings.wordbook.anki.v1`: enabled state, profile name, deck and note type IDs and display names, source and translation field names, and an optional credential reference. Do not save the session token. A first Save leaves the integration off; later saves keep the confirmed enable state. `setEnabled(true)` requires a complete binding and a readable key if one is referenced. Missing data defaults to off. Malformed data or an unreadable referenced key makes the binding inactive and shows a local error; it must not stop the shell from opening. Neither load nor toggle contacts Anki.
- [ ] **Next cycles:** Use separate `settings.wordbook.anki.credentials.<ref>` entries for optional keys. Keep a saved key on a blank edit, accept a nonblank replacement, and support explicit removal. Never load a saved key into the input. Write a replacement key before the binding; commit the binding before removing the old key. On failure keep the old binding and key, clean up the unused new key, and report a fixed error. Test both write failures. Disable does not erase the key or change notes in Anki.
- [ ] **Red/green:** `mise exec -- nsh test features/wordbook/settings.test.ts --filter "wordbook settings:"`. Expect the new default, reload, or rollback assertion to fail first and then pass.

### 5. Configure Anki from the main sidebar

**Seam:** Wordbook through `AppShell`.

- [ ] **Red:** In `app/quick-translate.test.tsx`, open `nav-wordbook`. Expect the new page, Anki only, an off switch, and no HTTP calls. In the next cycle, press Test Connection, select a deck and note type with fixture names, select the translation field, save, and enable. Reopen the page and expect the saved choices without a new HTTP call.
- [ ] **Green:** Record the motion inventory in `DESIGN.md` before starting TSX changes. Add `wordbook` to `SidebarPage`, place it after Presets, and route it through `navigateTo` to honor existing leave guards. Load the store in `App.tsx` and the harness. Use `PageSurface` with `layout="column"` and the shared `Card`, `SectionHeading`, `Select`, `Input`, `Switch`, and `Button` in `features/wordbook/page.tsx`.
- [ ] **Green:** Show the Anki Desktop and AnkiConnect prerequisite, a masked optional key, **Test Connection**, and the active profile after connection. Test Connection loads decks and type summaries; selecting a type loads its fields. Show its first field as the fixed **Source field** and allow one other field as **Translation field**. Select the only available translation field if there is just one. Do not guess from localized names. Save requires a complete choice from the latest test and field read. Clear dependent choices after a change of profile or note type. Invalidate discovery when the key draft changes. Ignore stale replies. Keep saved choices visible after reload, but require a new connection check before editing the target. A failed check does not disable a saved target. A failed save keeps the previous binding. Use the existing leave guard for unsaved edits and discard only on confirmation.
- [ ] **Next cycles:** Cover missing or invalid configuration, saved masked key and explicit key removal, a failed connection check, a late field result after a different selection, disabling, and navigation away from dirty edits. Use localized labels and error text from `t()` in both locale files; display profile, deck, and field names as Anki data. Give icon buttons a localized accessible name. Use the existing page entrance, Select popup, switch, and button feedback. Replace status text in place; do not introduce new layout animation.
- [ ] **Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter "wordbook page:"`. Expect the route, configuration, or persistence assertion to fail first and then pass.
- [ ] **Native checkpoint:** Before wiring the card action, run `mise run dev` on Windows and use Test Connection against the baseline AnkiConnect release. Confirm that NSH can reach the local endpoint and read real deck and field names. This check makes no writes to Anki.

### 6. Add the selected Quick Translate result

**Seam:** Quick Translate through `AppShell`.

- [ ] **Red:** In `app/quick-translate.test.tsx`, seed a saved, enabled target and complete two forward cards with different translations. Before a press, expect no Anki requests. Press **Add to Anki** on the second card. Verify that the write contains the actual source and only the second translation. Delay the reply; only that card shows **Adding…**, and no second write can start. Return success and expect **Added to Anki** on that card only.
- [ ] **Green:** In `app/quick-translate.tsx`, connect the saved binding and real client to the session. In `features/quick-translate/session.ts`, add the action and feedback to the selected result. Capture source text from the card query's translation context, not the current editor. Take the card's successful text and saved binding at press time. Allow one add in flight across the popup, including while it is hidden. Already-sent writes may complete after the popup closes; do not treat closure as cancellation or reopen the window. Use query identity, window epoch, and binding identity to drop feedback for stale results or changed settings. Do not persist success flags or note IDs.
- [ ] **Green:** In `features/quick-translate/popup.tsx`, put the shared `Button` beside Copy in the forward result toolbar. Show it only when the integration is enabled and the result is complete and nonblank. Give it a localized tooltip and accessible name, with the same control size during progress and success. Use a check glyph for confirmed success; it is not a toggle and cannot delete an Anki note. Show duplicate, configuration, and connection feedback beside the affected card without stealing focus. Keep it visible and actionable if Anki closes after setup.
- [ ] **Next cycles:** Verify no action for disabled or incomplete setup, streaming, empty or failed results, back-translation, or history. Verify that source edit, template change, close and reopen, or disabling during a delayed operation cannot put old feedback on a new result or start a duplicate write. Verify duplicate and unconfirmed states do not show **Added** and preserve the result. Reuse icon press and tooltip motion; swap the status glyph and text in place. At minimum popup width, the button and retry action must not overlap.
- [ ] **Red/green:** `mise exec -- nsh test app/quick-translate.test.tsx --filter "quick anki:"`. Expect the new action, payload, or feedback assertion to fail first and then pass.

## Failure Behavior

| Condition | Result and recovery |
| --- | --- |
| Anki not reachable during a read | Ask the user to start Anki Desktop and check that AnkiConnect is enabled on the default local port. Keep the result and offer another explicit press. |
| Unauthorized, forbidden, or v1 unavailable | Ask the user to check the key, add-on access, or plugin version as applicable. Do not suggest widening access to all origins or exposing the listener to a network. |
| No collection, wrong profile, stale session, missing deck or type, or changed fields | Ask the user to open the configured Anki profile or recheck the destination in Wordbook. Do not write to a fallback target. |
| Duplicate under Anki's first-field comparison, for the selected deck and note type only | Tell the user that the source already exists and its translation was not changed. Do not mark the selected pair as added. |
| Rejected content, including a template that produces no question | Explain that Anki could not create the card. Ask the user to check the selected note type or fields. Never display Anki's raw error text. |
| Write outcome unknown | Show **Could not confirm the add. Check Anki before trying again.** Do not retry automatically. The request ID does not prevent duplicate writes. |

## Privacy and Security

- Anki requests go only to `127.0.0.1:8765`; reject redirects. Do not change Anki's bind address, origin list, or add-on settings. Use no polling, cloud relay, or extra content cache.
- Only an explicit Add press sends text to Anki. Setup and preflight requests contain no translation text. Do not send context, screenshots, audio, translation settings, or provider keys. Anki owns its own sync behavior after the write.
- Record only request metadata, status, and safe error categories. Omit headers, profile and deck data, text, and raw provider or transport errors even at debug level. Explain in the key help that a supplied key stays in local NSH Storage and is not encrypted. Never write a real key to tests or documentation.

## Rollout, Risks, and Final Validation

- [ ] Update `README.md` with the install code `2055492159`, the default local endpoint, the need to keep Anki open, and the one-target setup steps. Do not claim support for versions or desktop targets that were not verified. No migration or automatic enablement is needed.
- [ ] Run `mise run verify`. Expect formatting, lint, types, tests, and build to pass. Run `mise exec -- nsh test app/quick-translate.test.tsx --target windows --filter "wordbook page:"` and `mise exec -- nsh test app/quick-translate.test.tsx --target windows --filter "quick anki:"` separately: `mise run test-desktop` does not include `app/*.test.tsx`.
- [ ] Run `mise run dev` on Windows with a real Anki instance and an authorized temporary profile and deck. Record the Anki Desktop and AnkiConnect versions. Check that Test Connection does not add a note. Add a result with non-ASCII text, literal `<` and `&`, and a line break; inspect the generated card in Anki. Add the same source with a different translation and verify no second note or overwrite. Switch profiles or remove the test deck and check that the app refuses to write. Verify both no-key and configured-key access and the recovery when Anki is closed. If real access is unavailable, report live compatibility as unverified; fixtures do not prove it.
- [ ] Check the sidebar and result card at minimum size, in light and dark, in English and Simplified Chinese, with reduced motion, and by keyboard and Narrator. Check the NSH finishing checklist and each motion entry. Verify visible focus, non-overlapping controls, masked input, and announced progress and failure. Use the existing window fit and dismissal rules.

**Open questions:** None that block the plan. Live release compatibility is a release check, not an assumption about older AnkiConnect builds.

[api]: https://git.sr.ht/~foosoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/API_V1.md
[addon]: https://ankiweb.net/shared/info/2055492159
[duplicates]: https://docs.ankiweb.net/editing.html#duplicate-check
[service]: https://git.sr.ht/~foosoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/plugin/services.py
[protocol]: https://git.sr.ht/~foosoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/plugin/protocol.py
