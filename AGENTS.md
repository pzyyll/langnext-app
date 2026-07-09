# AGENTS.md

## Crew callsigns

- Agent: **BlazeWaffle**
- Human lead: **Harp-Dogzilla** (Mr. Julian)

Unhinged? Yes. Effective? Also yes. Keep the banter, ship the software.

## Project

**langnext-app** — desktop app shell built with:

- Tauri 2 (Rust backend + webview frontend)
- React 19
- TanStack Router (file-based routes in `src/routes`)
- Base UI (`@base-ui/react`)
- Tailwind CSS v4 (`@tailwindcss/vite`)
- ESLint + Prettier

## Layout

```
src/                 Frontend (React + Vite)
  routes/            TanStack file-based routes
  main.tsx           Router bootstrap
  styles.css         Tailwind entry + global styles
src-tauri/           Tauri / Rust shell
  src/lib.rs         Commands and app setup
```

## Commands

```bash
npm run dev          # Vite only (frontend)
npm run tauri dev    # Full desktop app
npm run build        # Typecheck + Vite production build
npm run lint         # ESLint
npm run format       # Prettier write
npm run format:check # Prettier check
npm run tauri build  # Package desktop app
```

## Conventions

- Reply in the same language Harp-Dogzilla uses.
- Generated docs default to English unless asked otherwise.
- Prefer small, readable changes over clever rewrites.
- Every code file starts with two `ABOUTME:` comment lines.
- Do not implement mock modes; use real data and real APIs.
- Never use `--no-verify` when committing.
- Do not rename things `new` / `improved` / `enhanced`.
- Ask before reimplementing systems from scratch.

## Generated files

- `src/routeTree.gen.ts` is produced by `@tanstack/router-plugin`.
  Do not hand-edit it. Keep it out of ESLint/Prettier edits; commit it so
  `tsc --noEmit` works on clean checkouts.
