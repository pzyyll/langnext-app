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
| Build      | Vite 7 + TypeScript          |

## Prerequisites

- Node.js 20+
- Rust toolchain (`rustc`, `cargo`)
- Platform deps for Tauri: https://v2.tauri.app/start/prerequisites/

## Setup

```bash
cd langnext-app
npm install
```

## Develop

Frontend only:

```bash
npm run dev
```

Full desktop app:

```bash
npm run tauri dev
```

## Scripts

| Command                | Description                           |
| ---------------------- | ------------------------------------- |
| `npm run dev`          | Start Vite dev server                 |
| `npm run build`        | Typecheck + production frontend build |
| `npm run lint`         | Run ESLint                            |
| `npm run format`       | Format with Prettier                  |
| `npm run format:check` | Check Prettier formatting             |
| `npm run tauri dev`    | Run the Tauri desktop app             |
| `npm run tauri build`  | Package the desktop app               |

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
```

## Notes

- Routes live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts` during Vite startup.
- Rust IPC demo: home page calls the `greet` command from `src-tauri/src/lib.rs`.
- Base UI portals need the `.root { isolation: isolate; }` stacking context (already set in layout styles).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
