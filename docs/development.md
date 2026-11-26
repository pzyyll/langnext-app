# Development

This document is for people who build Langnext. The application guide for users is the [README](../README.md).

Langnext is a desktop application built with NSH Mixed. TSX owns the interface and state. Rust provides an extension entry for features that need native code.

## Set up

Install [mise](https://mise.jdx.dev/). Then run:

```sh
mise trust
mise install
mise run setup
mise run dev
```

Mixed builds need a native Rust toolchain. On Windows, install Git for Windows (for Bash), Visual Studio Build Tools with Desktop development with C++, the Windows SDK, and LLVM. On macOS and Linux, make the file tasks executable with `chmod +x .mise/tasks/*` after checkout. See [NSH installation](https://nsh.dev/docs/installation).

If MSVC reports `D8050` or `LNK1104` for temporary files, create `.nsh/tmp/`. Set `TEMP` and `TMP` to that directory's absolute path in the ignored `mise.local.toml`, under `[env]`. Keep this machine-specific override out of Git.

## Commands

All project commands are in `.mise/tasks/`.

| Command | Action |
| --- | --- |
| `mise run dev` | Start the desktop app with TSX hot updates. |
| `mise run build` | Build the release bundle in `.nsh/out/`. |
| `mise run check` | Check Rust and TypeScript with NSH. |
| `mise run lint` | Run oxlint and Rust Clippy. |
| `mise run format` | Format source and configuration files. |
| `mise run format-check` | Check formatting without changes. |
| `mise run test` | Run Rust tests and headless NSH tests. |
| `mise run test-desktop` | Run the UI tests in desktop windows. |
| `mise run verify` | Run formatting, lint, type checks, tests, and build. |
| `mise run package -- --target windows` | Package the app for Windows. |

The first NSH check or build generates editor types in `.nsh/`. Do not edit or commit that directory. Keep the NSH CLI and Rust crate versions aligned. pnpm provides development tools only. It is not the app runtime.

## Logging

App code logs through `createLogger` in `services/log.ts`. Native code logs through the `log` crate. A packaged build writes the kept lines to the app's rolling log and to the platform log. A development host prints them to the terminal.

- **File**: `logs/app.log` in the app data directory (`%APPDATA%\com.dev.langnext\logs\app.log` on Windows). It rolls over at 5 MiB and keeps three older files, `app.1.log` through `app.3.log`.
- **Levels**: **Settings → General → Log level** sets the lowest level that the app's TypeScript log calls write: **Error**, **Warning**, or **Info** (**Warning** by default). `debug` lines stay outside that setting. NSH keeps them only with `RUST_LOG=debug`, in a packaged build.
- **Native lines**: Rust lines follow NSH's own filter, not the setting. NSH uses `RUST_LOG` where it reads that variable. Otherwise a packaged build keeps `warn` and `error`.
- **Development**: `nsh run` (`mise run dev`) prints the kept lines to the terminal. The Windows development host caps its log at `info` and does not read `RUST_LOG`, so `debug` lines do not appear there.
- **Path**: `logFile()` (or `process.logFile`) returns the file path, or `null` where the lines go to the platform log only. **Settings → General → Logs → Open folder** opens the folder that holds the file.
- **Secrets**: never log API keys or credentials. Request and response bodies go only to `debug` lines. `services/http.ts` masks credentials in what it logs.

## Structure

- `App.tsx`: load settings and mount the application once.
- `src/app/`: application shell, navigation, and the system tray.
- `assets/logos/`: app icon assets. `icon.png` is the tile that NSH packages. `icon.svg` is the glyph that the system tray draws.
- `src/components/`: styled controls built on NSH base components.
- `src/features/settings/`: appearance state and the settings screen.
- `src/services/`: the models.dev catalog client and the app's scoped logger.
- `theme.json`: semantic light and dark tokens from the design system.
- `ext/langnext-native/`: the app's Rust nshm. `src/lib.rs` registers native exports (`langnext-native`) for Windows cursor monitor anchor lookup and Raw Input double-copy detection.
- `ext/langnext-native/src/database/`: shared SQLite access and ordered schema migrations for `langnext.sqlite3` in the app data directory. Native features own their queries.
- `src/platform/`: cross-display popup placement helpers and a thin wrapper over `langnext-native`.

## Quick Translate notes

The floating panel is 420 by 360 points.

Global shortcut registration, mixed-DPI physical cursor anchor placement, and Raw Input (`RIDEV_INPUTSINK`, keyboard only) double-copy monitoring target Windows.

Quick Translate preferences stay in NSH `Storage` under `quickTranslate.preferences.v1`: `doubleCopyEnabled`, `autoTranslate`, `sourceLanguage`, `targetLanguage`, and ordered `{ id, presetId, templateId, collapsed }` cards. The app does not save pin state. Provider keys stay in NSH `Storage`. A DeepL preset references its key, which the app stores separately.

The app database keeps translation history. It is local and is not encrypted.

Wordbook does not migrate older settings.

## Language detection notes

There is no local detector.

- **Request shape**: AI detection uses one buffered request for each enabled AI detector, never a stream, and asks the model to skip reasoning. The answer is a single language ID. The free Google detector uses one form-encoded request, so the sample is not placed in a URL. Google Cloud detection sends one buffered JSON request with the key in the `x-goog-api-key` header. It calls the Cloud Translation v2 `detect` endpoint.
- **Language mapping**: a regional Google code keeps its base language (`zh-CN` becomes `zh`, `pt-BR` becomes `pt`). Legacy `iw` and `in` map to Hebrew and Indonesian. Any other language is reported as unsupported. It is not translated as a guess.
- **Privacy**: only settings, model IDs, and the stored API key are kept. The Google Cloud key is stored in its own storage entry, not in the detector record.

## Checks before distribution

The bundle identifier is a development placeholder. Set it before distribution.

Headless tests do not verify native dragging, caption buttons, tooltips, or platform permissions. Check those in a desktop window before release. On Windows, `mise run test-desktop` also checks that the native cursor's monitor ID matches a display reported by NSH.

## License

See [License](license.md).
