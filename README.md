# langnext-app

Desktop app starter built with **Tauri 2** and a modern React frontend.

## Stack

| Layer      | Choice                       |
| ---------- | ---------------------------- |
| Shell      | Tauri 2                      |
| UI         | React 19                     |
| Routing    | TanStack Router (file-based) |
| Components | Base UI                      |
| Styling    | Tailwind CSS v4              |
| Tooling    | ESLint + Prettier            |
| Build      | Vite 8 + TypeScript          |
| Runtime    | mise (node, bun, rust)       |
| Packages   | bun                          |

## Prerequisites

- [mise](https://mise.jdx.dev/) (toolchain manager)
- Platform deps for Tauri: https://v2.tauri.app/start/prerequisites/

Tool versions are pinned in `mise.toml` (`node`, `bun`, `rust`).

## Setup

```bash
cd langnext-app
mise install
bun install
```

Or with mise tasks:

```bash
mise install
mise run install
```

## Develop

Frontend only:

```bash
bun run dev
# or: mise run dev
```

Full desktop app:

```bash
bun run tauri dev
# or: mise run tauri:dev
```

## Scripts

| Command                | Description                           |
| ---------------------- | ------------------------------------- |
| `bun run dev`          | Start Vite dev server                 |
| `bun run build`        | Typecheck + production frontend build |
| `bun run lint`         | Run ESLint                            |
| `bun run format`       | Format with Prettier                  |
| `bun run format:check` | Check Prettier formatting             |
| `bun run tauri dev`    | Run the Tauri desktop app             |
| `bun run tauri build`  | Package the desktop app               |

Mise task aliases: `mise run install|dev|build|lint|format|tauri:dev|tauri:build`.

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
mise.toml               Toolchain + task definitions
```

## Notes

- Routes live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts` during Vite startup.
- Rust IPC demo: home page calls the `greet` command from `src-tauri/src/lib.rs`.
- Base UI portals need the `.root { isolation: isolate; }` stacking context (already set in layout styles).
- Use **bun** only (do not commit `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
