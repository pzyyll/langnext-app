# AGENTS.md

My Translator is a desktop application built with:

- UI Framework `NSH`: For more information, see `@docs/llms.txt`
- mise toolchain

## UI/UX

Design docs: `@docs/ui/DESIGNE.md`

- Icons:
  - [icon-park-outline](https://icon-sets.iconify.design/icon-park-outline/)
  - [icon-park-solid](https://icon-sets.iconify.design/icon-park-solid)

### Interface copy

- Keep the interface bare: page titles, section headings and control labels carry the meaning. Add a line only when it changes a decision (scope, consequence, or recovery); remove subtitles, taglines and option descriptions that only explain what the heading or label already makes obvious.

### Styling

- Style controls and layout with `class` and Tailwind utilities first (`w-full`, `p-8`, `gap-7`, `text-sm`).
- Use `style` only for values computed at run time: platform metrics (`titleBar()`), theme colors (`token()`), or animation. Say why in a comment when you do.
- Avoid concrete pixel numbers (`16`, `824`, `max-w-[824px]`). Take the nearest scale step (`p-4`, `max-w-4xl`) before inventing an arbitrary value; if a number is genuinely required, define it in the design system (`theme.json`, `@docs/ui/DESIGNE.md`) and reuse it.

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
| `mise run test`                        | Run Rust tests and headless NSH tests.               |
| `mise run test-desktop`                | Run the UI tests in desktop windows.                 |
| `mise run verify`                      | Run formatting, lint, type checks, tests, and build. |
| `mise run package -- --target windows` | Package the app for Windows.                         |

## Commits

- After each completed task that changed files, commit the task's changes; leave every commit local and push only when the user explicitly asks.
- Write Conventional Commit messages (`<type>[scope]: <description>`). A `feat`, `fix` or `perf` type, a `!` breaking marker, a `BREAKING CHANGE` footer, or any other version keyword needs the user's approval before you commit; wait for it and never choose such a message on your own.
- `docs`, `test`, `chore`, `refactor`, `style`, `ci` and `build` are release-neutral and need no approval.
