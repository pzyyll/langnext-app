# My Translator

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

## Structure

- `App.tsx`: Load settings and mount the application once.
- `app/`: Application shell, navigation, and the system tray.
- `assets/logos/`: App icon assets: the `icon.png` tile NSH packages and the
  `icon.svg` glyph the system tray draws.
- `components/`: Styled controls built on NSH base components.
- `features/settings/`: Appearance state and settings screen.
- `theme.json`: Semantic light and dark tokens from the design system.
- `src/lib.rs`: Native export registration (`my-translator/native`) for Windows cursor monitor anchor lookup and Raw Input double-copy detection.
- `platform/`: Cross-display popup placement helpers and thin wrapper over `my-translator/native`.

## Quick Translate

Quick Translate runs in a compact floating panel (`420 × 360` points, available even when the main window is hidden) and supports independent multi-preset result cards sharing one source input and language pair:

- **Activation paths**: Open or focus via the system tray menu (**Quick Translate**) on any desktop, or with a Windows global shortcut in **Settings → Application → Shortcuts**. **Open Quick Translate** defaults to `Alt+Shift+D`. Select **Edit** and press a key combination to save it. Select **Clear** to remove it, or **Reset** to restore the default when the binding differs from it. **Screenshot Translate** defaults to `Alt+Shift+S`. Select a screen region to open Quick Translate, recognize the text, and translate it with the enabled presets. **Translate Selection** defaults to `Alt+D` on Windows. It reads the current foreground selection through UI Automation and translates that text. It does not read the clipboard or use OCR. A password field, a missing selection, or an unreadable control opens Quick Translate and keeps the current draft. **Double-copy Quick Translate (`Ctrl+C × 2`)** is fixed and can be turned on or off.
- **Selection support**: On Windows, selection reading worked in Notepad, Word, and Chrome's Google Search results. It did not return text from the tested X page, VS Code editor, Adobe Acrobat PDF, or Windows Terminal. Results can vary by page and app version.
- **Shortcut conflict recovery**: If the saved shortcut is unavailable at launch, the app warns you and the tray menu remains available. If a replacement cannot register or save, the previous shortcut stays active. If **Open Quick Translate** or **Screenshot Translate** already uses `Alt+D`, that action keeps the key and **Translate Selection** stays inactive until you record a free combination. `Alt+D` can also focus the address bar in Edge or File Explorer. Select **Clear**, or record another combination, to give that key back. **Reset** tries `Alt+D` again and keeps the saved value when the key is still taken.
- **Windows support & opt-in defaults**: Global shortcut registration, mixed-DPI physical cursor anchor placement, and Raw Input (`RIDEV_INPUTSINK` keyboard-only) double-copy monitoring target Windows. Both double-copy activation and popup **Auto-translate** (`500 ms` debounce) default to **off**. Copied text translates as soon as the window shows it, whatever **Auto-translate** says; source and target languages are configured from the title-bar language menu, and typing, paste, and language changes translate on **Enter** (`Shift+Enter` for newlines) or that toggle.
- **Data destinations & privacy**: Quick Translate preferences persist exclusively in NSH `Storage` under `quickTranslate.preferences.v1` (`doubleCopyEnabled`, `autoTranslate`, `sourceLanguage`, `targetLanguage`, and ordered `{ id, presetId, templateId, collapsed }` cards). Pin state, source drafts, translated outputs, error text, keystroke history, and API keys are never persisted there or logged. Provider keys stay in NSH `Storage`, and a DeepL preset's key is stored separately from its preset record under a non-secret reference. Text is sent only to the enabled preset cards the user added: their AI models or DeepL.

See [system architecture](docs/specs/system-architecture.md) and
[design system](docs/ui/DESIGNE.md) for the selected scope.

## Language detection

Language detection resolves an **Automatic** source or target into a concrete
language before a prompt is rendered. Two detectors are available and neither
falls back to the other; there is no local detector.

- **Setup**: Open **Settings → Language Detection**, choose **Detection**, set
  the **Native language** and the language for **Translate my native language
  into**, then save. Detection stays off until that save.
- **AI**: Choose **AI**, then a primary model and optional backups in order. A
  sample goes to the chosen model, and to the backups if the earlier answers are
  unusable.
- **Google**: Choose **Google** to use the free Google Translate endpoint. It
  needs no key and no model configuration; a sample goes to Google Translate.
- **Automatic target**: Text in another language is translated into your native
  language. Text in your native language is translated into the preferred
  translation language. A concrete source and target pair never starts a
  detection request.
- **Upstream choices**: Presets store engine configuration only; the Quick
  Translate language menu offers **Automatic** for both selections. With
  detection off, an **Automatic** source needs a manual source selection, and an
  **Automatic** target needs a native language.
- **Fallback behavior**: A blocked or failed detection never guesses. The card
  shows a localized message that asks you to choose the source manually.
  Cancellation stays silent.
- **Request shape**: AI detection uses one buffered request per configured
  model, never a stream, and asks the model to skip reasoning because the answer
  is a single language ID. Google detection uses one form-encoded request, so the
  sample never appears in a URL.
- **Language mapping**: A regional Google code keeps its base language
  (`zh-CN` → `zh`, `pt-BR` → `pt`), legacy `iw` and `in` map to Hebrew and
  Indonesian, and any other language is reported as unsupported instead of
  translated as a guess.
- **Privacy**: Detection runs only inside a translation action with an
  automatic source. Each detector receives the first 2,048 characters of the
  trimmed text, and may use a different provider than the translation model. The
  full source text still goes to the selected translation model. Only settings
  and model IDs are stored; samples, detected values, and model replies are
  never stored or logged.

The bundle identifier is a development placeholder. Set it before distribution.
Headless tests do not verify native dragging, caption buttons, tooltips, or
platform permissions. Check those in a desktop window before release. On
Windows, `mise run test-desktop` also checks that the native cursor's monitor
ID matches a display reported by NSH.
