# langnext-app

Desktop app starter built with **Tauri 2** and a modern React frontend.

## Stack

| Layer           | Choice                                 |
| --------------- | -------------------------------------- |
| Shell           | Tauri 2                                |
| UI              | React 19                               |
| Routing         | TanStack Router (file-based)           |
| Data cache      | TanStack Query                         |
| IPC / workflows | Effect 3.x (typed invoke + multi-step) |
| Components      | Base UI                                |
| Styling         | Tailwind CSS v4 (Base UI outline)      |
| Tooling         | ESLint + oxfmt                         |
| Build           | Vite 8 + TypeScript                    |
| Runtime         | mise (node, bun, rust, tasks)          |
| Packages        | bun                                    |

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

| Command                  | Description                           |
| ------------------------ | ------------------------------------- |
| `mise run install`       | Install JS deps with bun              |
| `mise run dev`           | Start Vite dev server                 |
| `mise run build`         | Typecheck + production frontend build |
| `mise run typecheck`     | TypeScript check only                 |
| `mise run preview`       | Preview production frontend build     |
| `mise run lint`          | Run ESLint                            |
| `mise run format`        | Format with oxfmt + rustfmt           |
| `mise run format:check`  | Check oxfmt + rustfmt formatting      |
| `mise run test`          | Run Rust unit/integration tests       |
| `mise run test-frontend` | Run frontend behavioral tests (Bun)   |
| `mise run tauri:dev`     | Run the Tauri desktop app             |
| `mise run tauri:build`   | Package installers and portable zip   |

Optional test filter: `mise run test storage` (args are forwarded to `cargo test`).

### Native credential vault lifecycle (manual / release platforms)

The ignored integration test requires an interactive OS credential store session:

```bash
mise exec -- cargo test --manifest-path src-tauri/Cargo.toml native_vault_smoke -- --ignored
```

This writes a disposable vault entry, reads it back, and deletes it. Run on each release platform (Windows Credential Manager, macOS Keychain, Linux Secret Service) before shipping credential-related changes.

## Project structure

```
src/
  main.tsx              App bootstrap + router
  styles.css            Tailwind entry
  routes/
    __root.tsx          Layout + nav
    index.tsx           Root redirect → /translate
    about.tsx           Stack overview
src-tauri/
  src/lib.rs            Tauri commands
  tauri.conf.json       App config
mise.toml               Toolchain versions
.mise/tasks/            File-based project tasks
```

## Plugins

Runtime plugin content comes from three sources. Every content set gets an immutable digest identity.

| Source      | Location                       | Notes                                           |
| ----------- | ------------------------------ | ----------------------------------------------- |
| Built-in    | `src-tauri/resources/plugins/` | Ships with the app and is the automatic default |
| Development | `LANGNEXT_PLUGIN_DEV_DIR`      | Debug builds only                               |
| User        | `<app-data>/plugins`           | Wasm archives with one permission review        |

Built-in authenticity comes from the application installer and the protected resource location. User archives are untrusted content; the app reviews their permissions for one exact content digest. See the [plugin catalog architecture](docs/architecture/plugin-catalog.md).

## Notes

- Routes live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts` during Vite startup.
- `/` redirects to `/translate` (primary workspace); there is no dedicated Home page.
- Storage (Providers, models, profiles, settings, credentials, device state) is Rust-owned; React uses typed invoke wrappers under `src/storage/` (Effect `IpcError` / `invokeEffect` under a Promise bridge). See `docs/analysis/storage-architecture.md` and `docs/architecture/frontend-state-management.md` (Effect vs Query).
- Base UI portals need the `.root { isolation: isolate; }` stacking context (already set in layout styles).
- Use **bun** only for packages (do not commit `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`).
- Use **mise file tasks** only for project commands (`.mise/tasks/`, not `package.json` scripts or TOML tasks).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
