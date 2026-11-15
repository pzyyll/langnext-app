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
- `src/lib.rs`: Native export registration. No native features are added yet.

See [system architecture](docs/specs/system-architecture.md) and
[design system](docs/ui/DESIGNE.md) for the selected scope.

The bundle identifier is a development placeholder. Set it before distribution.
Headless tests do not verify native dragging, caption buttons, tooltips, or
platform permissions. Check those in a desktop window before release.
