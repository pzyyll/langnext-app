# AGENTS.md

My Translator is a desktop application built with:

- UI Framework `NSH`: Native Shell is a Rust-first native UI framework: build one app for iOS, Android, macOS, Windows, Linux and the web, with each platform’s own UI and interaction.
- mise toolchain

## Harness

- **Project is currently in the Demo stage, so there’s no need to consider compatibility with old data or formats when iterating on requirements. Assume all updates are breaking changes by default; just focus on fully implementing the requirements.**

## UI/UX

- Icons:
  - [icon-park-outline](https://icon-sets.iconify.design/icon-park-outline/)
  - [icon-park-solid](https://icon-sets.iconify.design/icon-park-solid)

### Interface copy

- Keep the interface bare: page titles, section headings and control labels carry the meaning. Add a line only when it changes a decision (scope, consequence, or recovery); remove subtitles, taglines and option descriptions that only explain what the heading or label already makes obvious.

### Localization

- Every string the user reads comes from `t()` in `nsh/i18n`, never from a literal in a component: labels, placeholders, accessibility labels and error messages. Add the key to both `locales/en.yml` and `locales/zh-CN.yml`.
- `features/settings/language.ts` owns the interface language: `system` follows the user's language, `en` and `zh-CN` override it, and the choice persists under `settings.language`.

### Styling

- Style controls and layout with `class` and Tailwind utilities first (`w-full`, `p-8`, `gap-7`, `text-sm`).
- Use `style` only for values computed at run time: platform metrics (`titleBar()`), theme colors (`token()`), or animation. Say why in a comment when you do.
- Avoid concrete pixel numbers (`16`, `824`, `max-w-[824px]`). Take the nearest scale step (`p-4`, `max-w-4xl`) before inventing an arbitrary value; if a number is genuinely required, define it in the design system (`theme.json`) and reuse it.

## Logging

- Log through `createLogger` from `services/log.ts`: `const log = createLogger("<area>/<module>")`, then `log.warn("Could not ...", error)`. Do not call `console.*` outside that module.
- Native code logs through the `log` crate (`log::warn!`, `log::debug!`). NSH writes both kinds to `logs/app.log` in the app data directory.
- Never log API keys, credentials, selected or translated text, or request bodies.

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
| `mise run icons`                       | Render `assets/logos/icon.png` from its SVG source.  |
| `mise run catalog`                     | Refresh the models.dev snapshot the app ships.       |
| `mise run test`                        | Run Rust tests and headless NSH tests.               |
| `mise run test-desktop`                | Run the UI tests in desktop windows.                 |
| `mise run verify`                      | Run formatting, lint, type checks, tests, and build. |
| `mise run package -- --target windows` | Package the app for Windows.                         |

## Commits

- After each completed task that changed files, commit the task's changes; leave every commit local and push only when the user explicitly asks.
- Write Conventional Commit messages (`<type>[scope]: <description>`). Only a major release needs the user's approval before you commit: a `!` breaking marker, a `BREAKING CHANGE` footer, or any other message that declares a major version. Wait for the answer; never choose a major-version message on your own.
- Minor and patch releases (`feat`, `fix`, `perf`) and release-neutral types (`docs`, `test`, `chore`, `refactor`, `style`, `ci`, `build`) commit without asking.

## Referencs

- `langnext-app`: `F:\workspace\my\langnext-app`
- `NSH` Docs: `https://nsh.dev/llms.txt`
