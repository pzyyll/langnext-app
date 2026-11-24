# Langnext

A desktop AI translator built with NSH Mixed. TSX owns the interface and state.
Rust provides an extension entry for features that need native code.

The initial screen has a narrow sidebar, a custom title bar, and appearance
settings. The Light, Dark, and System options persist across launches.

## Set up

Install [mise](https://mise.jdx.dev/). Then run:

```sh
mise trust
mise install
mise run setup
mise run dev
```

Mixed builds need a native Rust toolchain. On Windows, install Git for Windows
(for Bash), Visual Studio Build Tools with Desktop development with C++, the
Windows SDK, and LLVM. On macOS and Linux, make the file tasks executable with
`chmod +x .mise/tasks/*` after checkout.
See [NSH installation](https://nsh.dev/docs/installation).

If MSVC reports `D8050` or `LNK1104` for temporary files, create `.nsh/tmp/`.
Set `TEMP` and `TMP` to that directory's absolute path in the ignored
`mise.local.toml`, under `[env]`. Keep this machine-specific override out of Git.

## Commands

All project commands are in `.mise/tasks/`.

| Command                                | Action                                               |
| -------------------------------------- | ---------------------------------------------------- |
| `mise run dev`                         | Start the desktop app with TSX hot updates.          |
| `mise run build`                       | Build the release bundle in `.nsh/out/`.             |
| `mise run check`                       | Check Rust and TypeScript with NSH.                  |
| `mise run lint`                        | Run oxlint and Rust Clippy.                          |
| `mise run format`                      | Format source and configuration files.               |
| `mise run format-check`                | Check formatting without changes.                    |
| `mise run test`                        | Run Rust tests and headless NSH tests.               |
| `mise run test-desktop`                | Run the UI tests in desktop windows.                 |
| `mise run verify`                      | Run formatting, lint, type checks, tests, and build. |
| `mise run package -- --target windows` | Package the app for Windows.                         |

The first NSH check or build generates editor types in `.nsh/`.
Do not edit or commit that directory. Keep the NSH CLI and Rust crate versions
aligned. pnpm provides development tools only; it is not the app runtime.

## Logging

App code logs through `createLogger` in `services/log.ts`; native code logs through the
`log` crate. NSH writes every line to the app's rolling log and to the platform's log.

- **File**: `logs/app.log` in the app data directory
  (`%APPDATA%\com.dev.langnext\logs\app.log` on Windows). It rolls over at 5 MiB and
  keeps three older files, `app.1.log` to `app.3.log`.
- **Levels**: `warn` and `error` always reach the file, `info` from the app reaches it in
  every build, and `debug` needs `RUST_LOG`. Raise it with `RUST_LOG=debug mise run dev`,
  or limit it with `RUST_LOG=langnext=debug`.
- **Development**: `nsh run` (`mise run dev`) also prints every kept line to the terminal.
- **Path**: `logFile()` (or `process.logFile`) returns the file's path, `null` where the
  lines go to the platform's log only. `Settings → General → Logs → Open folder` opens
  the folder that holds it.
- **Secrets**: never log API keys, credentials, selected or translated text, or request
  bodies.

## Structure

- `App.tsx`: Load settings and mount the application once.
- `app/`: Application shell, navigation, and the system tray.
- `assets/logos/`: App icon assets: the `icon.png` tile NSH packages and the
  `icon.svg` glyph the system tray draws.
- `components/`: Styled controls built on NSH base components.
- `features/settings/`: Appearance state and settings screen.
- `services/`: The models.dev catalog client and the app's scoped logger.
- `theme.json`: Semantic light and dark tokens from the design system.
- `src/lib.rs`: Native export registration (`langnext/native`) for Windows cursor monitor anchor lookup and Raw Input double-copy detection.
- `src/database/`: Shared SQLite access and ordered schema migrations for `langnext.sqlite3` in the app data directory. Native features own their queries.
- `platform/`: Cross-display popup placement helpers and thin wrapper over `langnext/native`.

## Quick Translate

Quick Translate runs in a compact floating panel (`420 × 360` points, available even when the main window is hidden) and supports independent multi-preset result cards sharing one source input and language pair:

- **Card order**: Drag a preset card's header, or focus its grip and press the up or down arrow key, to reorder the cards. Select the header away from its chips and buttons to collapse or expand the card. The order is saved with the popup's preferences.
- **Activation paths**: Open or focus via the system tray menu (**Quick Translate**) on any desktop, or with a Windows global shortcut in **Settings → Application → Shortcuts**. **Open Quick Translate** defaults to `Alt+Shift+D`. Select **Edit** and press a key combination to save it. Select **Clear** to remove it, or **Reset** to restore the default when the binding differs from it. **Screenshot Translate** defaults to `Alt+S`. Select a screen region to open Quick Translate, recognize the text, and translate it with the enabled presets. **Translate Selection** defaults to `Alt+D` on Windows. It tries UI Automation first. **Simulate Copy to Get Text** is off by default. When enabled, it tries `Ctrl+C` on eligible controls that do not expose a reliable text selection. This can replace the clipboard contents. It does not use OCR. A password field, a missing selection, or an unreadable control opens Quick Translate and keeps the current draft. **Double-copy Quick Translate (`Ctrl+C × 2`)** is fixed and can be turned on or off.
- **Selection support**: Windows UI Automation worked in Notepad, Word, and Chrome's Google Search results. VS Code 1.146.0 returned the selected editor text with copy fallback enabled. The app does not translate VS Code's whole-line copy when there is no selection. The tested X page, Adobe Acrobat PDF, and Windows Terminal did not return text through UI Automation. Results can vary by page and app version.
- **Shortcut conflict recovery**: If the saved shortcut is unavailable at launch, the app warns you and the tray menu remains available. If a replacement cannot register or save, the previous shortcut stays active. If **Open Quick Translate** or **Screenshot Translate** already uses `Alt+D`, that action keeps the key and **Translate Selection** stays inactive until you record a free combination. `Alt+D` can also focus the address bar in Edge or File Explorer. Select **Clear**, or record another combination, to give that key back. **Reset** tries `Alt+D` again and keeps the saved value when the key is still taken.
- **Windows support & opt-in defaults**: Global shortcut registration, mixed-DPI physical cursor anchor placement, and Raw Input (`RIDEV_INPUTSINK` keyboard-only) double-copy monitoring target Windows. Both double-copy activation and popup **Auto-translate** (`500 ms` debounce) default to **off**. Copied text translates as soon as the window shows it, whatever **Auto-translate** says; source and target languages are configured from the title-bar language menu, and typing, paste, and language changes translate on **Enter** (`Shift+Enter` for newlines) or that toggle.
- **History**: The app database keeps the source text and successful results for the most recent 30 translation actions. History restores the saved results without requesting a new translation. The database is local and is not encrypted.
- **Data destinations & privacy**: Quick Translate preferences stay in NSH `Storage` under `quickTranslate.preferences.v1` (`doubleCopyEnabled`, `autoTranslate`, `sourceLanguage`, `targetLanguage`, and ordered `{ id, presetId, templateId, collapsed }` cards). The app does not save pin state, drafts, errors, or keystrokes as history. It does not log source text, translated text, or API keys. Provider keys stay in NSH `Storage`. A DeepL preset references its key, which the app stores separately. The app sends translation requests to the enabled preset cards you add.

See [system architecture](docs/specs/system-architecture.md) for the selected scope.

## Language detection

Language detection resolves an **Automatic** source or target into a concrete
language before a prompt is rendered. Three detectors are available; enabled
detectors run in priority order, and later ones act as backups. There is no
local detector.

- **Setup**: Open **Settings → Language Detection**, select **Add Channel**
  to add **AI** (select a model), **Google** (free endpoint, enabled on add), or
  **Google Cloud** (save an API key), and set the **Native language** and the
  **Target language**. Detection stays off until a detector is added and
  enabled.
- **AI**: One text model per AI detector. A sample goes to that model; an
  unusable answer falls through to the next enabled detector.
- **Google**: Add **Google** to use the free Google Translate endpoint. It needs
  no key and no model configuration; a sample goes to Google Translate.
- **Google Cloud**: Open **Google Cloud**, paste an API key, and save it. The
  key is stored in its own storage entry, never in the detector record, and the
  same key is reused when the field is left blank. Detection calls the Cloud
  Translation v2 `detect` endpoint with that key, which bills the project.
- **Priority**: Drag a detector's grip, or focus the grip and press the up and
  down arrow keys, to order them. The first enabled detector is the primary; later
  enabled detectors act as backups.
- **Automatic target**: Text in another language is translated into your native
  language. Text in your native language is translated into the **Target
  language**. A concrete source and target pair never starts a detection request.
- **Upstream choices**: Presets store engine configuration only; the Quick
  Translate language menu offers **Automatic** for both selections. With no
  detector enabled, an **Automatic** source needs a manual source selection, and
  an **Automatic** target needs a native language.
- **Reuse**: The popup detects an **Automatic** source once for one input. Reading
  the source aloud starts the same detection when it has not run yet, and later
  translations of that input, including card expands and retries, reuse the
  answer. Editing the input or changing the detector chain starts a new
  detection, and a failed detection is not reused.
- **Fallback behavior**: A blocked or failed detection never guesses. The card or
  the reading error shows a localized message that asks you to choose the source
  manually. Cancellation stays silent.
- **Request shape**: AI detection uses one buffered request per enabled AI
  detector, never a stream, and asks the model to skip reasoning because the
  answer is a single language ID. The free Google detector uses one form-encoded
  request, so the sample never appears in a URL. Google Cloud detection sends one
  buffered JSON request with the key in the `x-goog-api-key` header.
- **Language mapping**: A regional Google code keeps its base language
  (`zh-CN` → `zh`, `pt-BR` → `pt`), legacy `iw` and `in` map to Hebrew and
  Indonesian, and any other language is reported as unsupported instead of
  translated as a guess.
- **Privacy**: Detection runs only when a translation action or a reading request
  needs an automatic source, once per input. Every enabled detector tried receives
  the first 2,048 characters of the trimmed text, and may use a different provider
  than the translation model. The full source text still goes to the selected
  translation model. Only settings, model IDs, and the stored API key are kept;
  samples, detected values, and model replies are never stored or logged.

The bundle identifier is a development placeholder. Set it before distribution.
Headless tests do not verify native dragging, caption buttons, tooltips, or
platform permissions. Check those in a desktop window before release. On
Windows, `mise run test-desktop` also checks that the native cursor's monitor
ID matches a display reported by NSH.
