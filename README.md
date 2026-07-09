# langnext-app

Desktop app starter built with **Tauri 2** and a modern React frontend.

## Stack

| Layer      | Choice                        |
| ---------- | ----------------------------- |
| Shell      | Tauri 2                       |
| UI         | React 19                      |
| Routing    | TanStack Router (file-based)  |
| Components | Base UI                       |
| Styling    | Tailwind CSS v4 (Base UI outline) |
| Tooling    | ESLint + Prettier             |
| Build      | Vite 8 + TypeScript           |
| Runtime    | mise (node, bun, rust, tasks) |
| Packages   | bun                           |

## Prerequisites

- [mise](https://mise.jdx.dev/) (toolchain manager + task runner)
- Platform deps for Tauri: https://v2.tauri.app/start/prerequisites/

Tool versions are defined in `mise.toml`. Project tasks live under `.mise/tasks/`.

## Setup

```bash
cd langnext-app
mise install
mise run install
```

## Develop

Frontend only:

```bash
mise run dev
```

Full desktop app:

```bash
mise run tauri:dev
```

## Tasks

All commands go through mise (no `package.json` scripts):

| Command                 | Description                           |
| ----------------------- | ------------------------------------- |
| `mise run install`      | Install JS deps with bun              |
| `mise run dev`          | Start Vite dev server                 |
| `mise run build`        | Typecheck + production frontend build |
| `mise run typecheck`    | TypeScript check only                 |
| `mise run preview`      | Preview production frontend build     |
| `mise run lint`         | Run ESLint                            |
| `mise run format`       | Format with Prettier                  |
| `mise run format:check` | Check Prettier formatting             |
| `mise run tauri:dev`    | Run the Tauri desktop app             |
| `mise run tauri:build`  | Package the desktop app               |

## Project structure

```
src/
  main.tsx              App bootstrap + router
  styles.css            Tailwind entry
  routes/
    __root.tsx          Layout + nav
    index.tsx           Home (Rust greet + Base UI dialog)
    about.tsx           Stack overview
src-tauri/
  src/lib.rs            Tauri commands
  tauri.conf.json       App config
mise.toml               Toolchain versions
.mise/tasks/            File-based project tasks
```

## Notes

- Routes live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts` during Vite startup.
- Rust IPC demo: home page calls the `greet` command from `src-tauri/src/lib.rs`.
- Base UI portals need the `.root { isolation: isolate; }` stacking context (already set in layout styles).
- Use **bun** only for packages (do not commit `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`).
- Use **mise file tasks** only for project commands (`.mise/tasks/`, not `package.json` scripts or TOML tasks).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
