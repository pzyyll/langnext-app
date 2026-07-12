---
name: LangNext App
colors:
  surface: "#ffffff"
  surface-dim: "#e4e4e4"
  surface-bright: "#ffffff"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#f3f3f3"
  surface-container: "#f3f3f3"
  surface-container-high: "#e4e4e4"
  surface-container-highest: "#e4e4e4"
  on-surface: "#161616"
  on-surface-variant: "#555555"
  inverse-surface: "#121212"
  inverse-on-surface: "#f8f8f8"
  outline: "#161616"
  outline-variant: "#e4e4e4"
  surface-tint: "#0074ca"
  primary: "#161616"
  on-primary: "#ffffff"
  primary-container: "#161616"
  on-primary-container: "#ffffff"
  inverse-primary: "#59aaf8"
  secondary: "#555555"
  on-secondary: "#ffffff"
  secondary-container: "#f3f3f3"
  on-secondary-container: "#161616"
  tertiary: "#0074ca"
  on-tertiary: "#ffffff"
  tertiary-container: "#0074ca"
  on-tertiary-container: "#ffffff"
  error: "#cc272e"
  on-error: "#ffffff"
  error-container: "#cc272e"
  on-error-container: "#ffffff"
  primary-fixed: "#e4e4e4"
  primary-fixed-dim: "#555555"
  on-primary-fixed: "#161616"
  on-primary-fixed-variant: "#555555"
  secondary-fixed: "#f3f3f3"
  secondary-fixed-dim: "#e4e4e4"
  on-secondary-fixed: "#161616"
  on-secondary-fixed-variant: "#555555"
  tertiary-fixed: "#59aaf8"
  tertiary-fixed-dim: "#0074ca"
  on-tertiary-fixed: "#ffffff"
  on-tertiary-fixed-variant: "#ffffff"
  background: "#ffffff"
  on-background: "#161616"
  surface-variant: "#f3f3f3"
  # Project aliases (map to M3 roles at runtime)
  surface-2: "#f3f3f3"
  surface-3: "#e4e4e4"
  neutral: "#555555"
  line: "#161616"
  code: "#f2f2f2"
  disabled: "#717171"
  overlay: "#00000033"
  shadow: "#0000001f"
  # Dark theme counterparts ([data-theme="dark"])
  surface-dark: "#141313"
  surface-dim-dark: "#141313"
  surface-bright-dark: "#3a3939"
  surface-container-lowest-dark: "#0e0e0e"
  surface-container-low-dark: "#1c1b1b"
  surface-container-dark: "#201f1f"
  surface-container-high-dark: "#2b2a2a"
  surface-container-highest-dark: "#353434"
  on-surface-dark: "#e5e2e1"
  on-surface-variant-dark: "#c4c7c7"
  inverse-surface-dark: "#e5e2e1"
  inverse-on-surface-dark: "#313030"
  outline-dark: "#8e9192"
  outline-variant-dark: "#444748"
  surface-tint-dark: "#c8c6c5"
  primary-dark: "#c8c6c5"
  on-primary-dark: "#313030"
  primary-container-dark: "#161616"
  on-primary-container-dark: "#817f7f"
  inverse-primary-dark: "#5f5e5e"
  secondary-dark: "#c8c6c6"
  on-secondary-dark: "#303030"
  secondary-container-dark: "#464747"
  on-secondary-container-dark: "#b6b5b4"
  tertiary-dark: "#a2c9ff"
  on-tertiary-dark: "#00315b"
  tertiary-container-dark: "#00172f"
  on-tertiary-container-dark: "#2783d9"
  error-dark: "#ffb4ab"
  on-error-dark: "#690005"
  error-container-dark: "#93000a"
  on-error-container-dark: "#ffdad6"
  background-dark: "#141313"
  on-background-dark: "#e5e2e1"
  surface-variant-dark: "#353434"
  surface-2-dark: "#1c1b1b"
  surface-3-dark: "#2b2a2a"
  neutral-dark: "#c4c7c7"
  line-dark: "#8e9192"
  code-dark: "#292929"
  disabled-dark: "#8a8a8a"
  overlay-dark: "#00000080"
  shadow-dark: "transparent"
typography:
  headline-display:
    fontFamily: system-ui
    fontSize: 30px
    fontWeight: "700"
    lineHeight: 36px
    letterSpacing: "0"
  headline-md:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: "700"
    lineHeight: 32px
    letterSpacing: "0"
  headline-sm:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: "700"
    lineHeight: 28px
    letterSpacing: "0"
  title-dialog:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: "700"
    lineHeight: 24px
    letterSpacing: "0"
  body-md:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 24px
    letterSpacing: "0"
  body-tight:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 20px
    letterSpacing: "0"
  body-bold:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: "700"
    lineHeight: 20px
    letterSpacing: "0"
  label-sm:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: "400"
    lineHeight: 16px
    letterSpacing: 0.12em
  table-header:
    fontFamily: system-ui
    fontSize: 10px
    fontWeight: "600"
    lineHeight: 14px
    letterSpacing: 0.05em
  mono-key:
    fontFamily: ui-monospace
    fontSize: 14px
    fontWeight: "700"
    lineHeight: 20px
    letterSpacing: "0"
  code-inline:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: "400"
    lineHeight: 16px
    letterSpacing: "0"
rounded:
  sm: 0
  DEFAULT: 0
  md: 0
  lg: 0
  xl: 0
  full: 0
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  sidebar-width: 176px
  models-rail: 192px
  titlebar-height: 32px
  control-height: 32px
---

# Design System: LangNext App

## 1. Visual Theme & Atmosphere

LangNext App is a **desktop utility shell** (Tauri + React) with a sharp, outline-first aesthetic — think technical workstation UI rather than consumer SaaS softness. Surfaces stay paper-white in light mode and warm charcoal in dark mode. Interactive frames are drawn with **hairline borders** and **zero border-radius**, never soft pills or floating blur glass.

The mood is **calm, dense, and precise**: generous page gutters but compact 32px control heights, and a hard offset “frame shadow” (`0.25rem 0.25rem 0`) that makes cards, dialogs, and toasts feel like cut-paper panels on the canvas. Color is used sparingly — a cool **tertiary blue** for checked switches and status accents, and **error red** for destructive actions — so hierarchy stays typographic and structural rather than chromatic.

### Taste Profile

- **Density: 7/10 — Daily App Dense.** Compact enough for repetitive translation and model-management work, with 16px page gutters and 32px controls; never compress labels, helper text, or error feedback.
- **Variance: 4/10 — Structured Offset.** Strong left alignment, nested rails, and selective asymmetry; no decorative chaos, centered marketing heroes, or overlapping content.
- **Motion: 4/10 — Restrained Utility.** Motion explains route direction, panel state, and list changes. It never runs perpetually, competes with text, or turns the workstation into a showcase.
- **Creativity: 6/10 — Character Through Construction.** Zero-radius frames, hard offset shadows, dense type, and deliberate borders provide identity without ornamental gradients or novelty controls.

This is application software, not a landing page. Do not invent hero sections, promotional CTAs, feature-card marketing rows, dashboards, or decorative data visualizations.

## 2. Color Palette & Roles

Tokens live as CSS custom properties in `src/styles.css`, switched by `data-theme="light|dark"` on `<html>`. Material Design 3 role names are first-class; project aliases (`surface-2`, `surface-3`, `neutral`, `line`) keep component class names short. Tailwind utilities map through `@theme inline` (`bg-surface`, `text-on-surface`, `border-line`, `text-error`, …).

### Primary Foundation

| Token                                                              | Hex (light) | Hex (dark) | Role                                        |
| :----------------------------------------------------------------- | :---------- | :--------- | :------------------------------------------ |
| **Paper White / Warm Charcoal** (`surface` / `background`)         | `#ffffff`   | `#141313`  | App canvas, cards, inputs, shell chrome     |
| **Mist Gray** (`surface-2` / `surface-container-low`)              | `#f3f3f3`   | `#1c1b1b`  | Hover fills, active nav, secondary surfaces |
| **Stone Gray** (`surface-3` / `surface-container-high`)            | `#e4e4e4`   | `#2b2a2a`  | Pressed fills, disabled solid buttons       |
| **Deepest Plate** (`surface-container-lowest`)                     | `#ffffff`   | `#0e0e0e`  | Lowest nested surface (dark)                |
| **Raised Plate** (`surface-container-highest` / `surface-variant`) | `#e4e4e4`   | `#353434`  | Highest container step                      |

### Accent & Interactive

| Token                                 | Hex (light)                              | Hex (dark)              | Role                                                 |
| :------------------------------------ | :--------------------------------------- | :---------------------- | :--------------------------------------------------- |
| **Signal Blue** (`tertiary`)          | `#0074ca`                                | `#a2c9ff`               | Checked switches, success/info accents               |
| **On Tertiary**                       | `#ffffff`                                | `#00315b`               | Content on tertiary fills                            |
| **Ink Solid** (primary button fill)   | `on-surface` `#161616` on `surface` text | inverted via same roles | Save / commit actions (`bg-on-surface text-surface`) |
| **Outline Line** (`line` / `outline`) | `#161616`                                | `#8e9192`               | Control borders, card frames, hairline chrome        |

### Typography & Text Hierarchy

| Token                                                  | Hex (light) | Hex (dark) | Role                                       |
| :----------------------------------------------------- | :---------- | :--------- | :----------------------------------------- |
| **Near Black / Warm Paper** (`on-surface`)             | `#161616`   | `#e5e2e1`  | Headings, labels, body emphasis            |
| **Ash / Soft Mist** (`neutral` / `on-surface-variant`) | `#555555`   | `#c4c7c7`  | Secondary copy, inactive nav, placeholders |
| **Disabled** (`disabled`)                              | `#717171`   | `#8a8a8a`  | Disabled borders and labels                |

### Functional States

| Token                       | Hex (light)      | Hex (dark)      | Role                                                |
| :-------------------------- | :--------------- | :-------------- | :-------------------------------------------------- |
| **Alert Red** (`error`)     | `#cc272e`        | `#ffb4ab`       | Destructive buttons, error text, close-button hover |
| **On Error**                | `#ffffff`        | `#690005`       | Text on error fills                                 |
| **Code Wash** (`code`)      | `#f2f2f2`        | `#292929`       | Inline code backgrounds                             |
| **Scrim** (`overlay`)       | `#000000` @ 20%  | `#000000` @ 50% | Dialog backdrops                                    |
| **Frame Shadow** (`shadow`) | `#000000` @ ~12% | `transparent`   | Offset box-shadow for cards/dialogs/toasts          |

## 3. Typography Rules

### Hierarchy & Weights

The stack is **system UI sans** (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial`) with antialiased rendering. This native desktop choice is intentional: do not replace it with Inter, Google Fonts, or another downloaded display face. Scale tokens are registered in `@theme` as `text-headline-display`, `text-body-md`, `text-label-sm`, etc. Code, model keys, timestamps, and dense numeric values use the platform monospace stack (`ui-monospace`).

| Role (utility)                                 | Size / Line | Weight                            | Usage                                          |
| :--------------------------------------------- | :---------- | :-------------------------------- | :--------------------------------------------- |
| **Headline Display** (`text-headline-display`) | 30px / 36px | 700                               | Channel/provider display names (Models editor) |
| **Headline MD** (`text-headline-md`)           | 24px / 32px | 700                               | Page titles (Home, Models, Settings, About)    |
| **Headline SM** (`text-headline-sm`)           | 20px / 28px | 700                               | Section headers (Channels, Connection, Models) |
| **Title Dialog** (`text-title-dialog`)         | 16px / 24px | 700                               | Modal titles                                   |
| **Body MD** (`text-body-md`)                   | 14px / 24px | 400                               | Supporting paragraphs under page titles        |
| **Body Tight** (`text-body-tight`)             | 14px / 20px | 400                               | Controls, nav links, dense UI, descriptions    |
| **Body Bold** (`text-body-bold`)               | 14px / 20px | 700                               | Card titles, fieldset legends, toast titles    |
| **Label SM** (`text-label-sm`)                 | 12px / 16px | 400, tracking `0.12em`, uppercase | Kickers / eyebrow labels                       |
| **Table Header** (`text-table-header`)         | 10px / 14px | 600, tracking `0.05em`, uppercase | Column headers                                 |
| **Mono Key** (`text-mono-key`)                 | 14px mono   | 700                               | Model keys in tables                           |
| **Code Inline** (`text-code-inline`)           | 12px mono   | 400                               | Inline code chips                              |

### Spacing Principles

- Body copy sits on a relaxed 24px line (`body-md`); dense controls use 20px (`body-tight`).
- Uppercase labels use wide tracking so small caps remain readable without bold weight.
- Prefer weight and color (`on-surface` vs `neutral`) over size jumps for hierarchy.
- Form labels use `text-body-tight font-medium`; micro-hints use `text-xs text-neutral`.

## 4. Component Stylings

### Buttons

Shared constants live in `src/components/ui.ts`.

- **Shape:** `rounded-none` — perfectly square corners. Communicates tool-like precision.
- **Height:** fixed `h-control-height` = **32px**.
- **Outline (default):** 1px `line` border, `surface` fill, `on-surface` text; hover → `surface-2`, active → `surface-3`.
- **Primary solid:** `bg-on-surface` fill, `text-surface`, bold weight — used for Save/commit; hover/active via opacity.
- **Danger solid:** `error` fill and border, `on-error` text — destructive confirms.
- **Icon / ghost:** transparent, `neutral` icon; hover soft `surface-2` fill; size **28px** (`size-7`).
- **Focus:** 2px `on-surface` outline inset (`-outline-offset-1`).
- **Disabled:** `disabled` border/text; primary/danger fall back to `surface-3` fill.

### Cards & Containers

- **Frame card:** 1px `border-line`, `bg-surface`, padding `p-gutter` (16px), plus **`.shadow-frame`** (`0.25rem 0.25rem 0 var(--app-shadow)`).
- Stack cards in simple vertical gaps (`gap-6` / `gap-8` on pages).
- About page uses a **2-column grid** (`sm:grid-cols-2`) of frame cards for stack tech.
- Settings preference cards cap at `max-w-lg`; prose descriptions use `max-w-2xl`.
- Models workspace outer shell is a full-height frame card; inner sections (Connection, Models table) are nested frame sections with `p-6`.

### Navigation

- **Layout:** Frameless custom **titlebar** (`h-titlebar-height` = 32px) + collapsible **left sidebar** (`w-sidebar-width` = 176px) + main content with `p-gutter` (16px).
- **Nav links:** full-width, 40px tall (`h-10`), `neutral` text; hover soft fill; **active** = bordered cell with `surface-2` and `on-surface` text.
- **Settings** lives in a footer strip separated by a top `border-line`.
- Sidebar collapse animates width 200ms ease-out; closed state is `w-0` with no border; content keeps `min-w-sidebar-width` so labels do not reflow while collapsing.

### Inputs & Forms

- Square inputs/selects matching control height (32px), 1px `line` border, `surface` fill, `body-tight` type.
- Placeholder uses `neutral`; focus uses inset `on-surface` outline (same as buttons).
- Checkboxes and radios are square (`rounded-none`, `size-4`) with `accent-on-surface`.
- **Switch:** square track 36×20 (`w-9 h-5`), thumb slides; checked state uses **`tertiary`** fill/border; thumb flips to `surface` on checked.
- **Settings option rows:** full-width (or half on `sm+`) bordered cells with radio + icon; selected = `surface-2` + `on-surface` text (mirrors nav active).

### Dialogs

- Backdrop: full-viewport `bg-overlay` scrim with 150ms opacity fade.
- Popup: centered frame (`w-96` default; wider forms use `w-md`), offset shadow, `p-gutter`, 100ms scale/opacity enter (`0.98` → `1`).
- Title `text-title-dialog font-bold`; description `text-body-tight text-neutral`; actions right-aligned outline + primary/danger.
- Confirm dialog supports pending state (disabled actions, pending label) and optional danger confirm.

### Toasts

- Top-right stack (`fixed top-10 right-4`, below titlebar), width `w-sm`.
- Frame chrome: `border-line`, `bg-surface`, `shadow-frame`; stacked scale/peek with expand on viewport hover.
- Content: status icon + bold title + neutral description + ghost close.
- Variant cues: tertiary-tinted icons for success/info, error icon for errors, on-surface for warnings; left accent bar reinforces severity.
- Enter/exit from the right (~500ms custom ease); respect reduced motion.

### Domain-Specific: Models Workspace

- Nested **models rail** (`w-models-rail` = 192px) listing provider channels with drag handles (`⋮⋮`).
- Active channel: bold `on-surface` on `surface-2`; inactive `neutral` with hover fill.
- Enter/exit micro-animations (`animate-channel-enter` 150ms / `animate-channel-exit` 120ms, translateY ±4px); `motion-reduce:animate-none`.
- Dense tables with tiny tracked uppercase headers; outline buttons for Add channel / manual model.
- Provider display name can edit in place at **headline-display** scale; editor body uses generous `p-8` with sticky footer actions (`px-8 py-4` border-top bar).

### Titlebar

- 32px drag strip with sidebar toggle, optional brand mark, and Windows-style min/max/close.
- Window controls: full-height, min-width 40px, transparent; hover `surface-2`.
- Close hover turns **error** fill with **on-error** icon — the main chromatic flourish in chrome.
- Maximize hover (~620ms) may open native snap layout overlay (platform behavior, not a visual token).

## 5. Layout Principles

### Grid & Structure

- Full-height shell: `html/body/#root` height 100%, overflow hidden; **main** scrolls.
- Sidebar width token: **11rem** (176px); models secondary rail **12rem** (192px); titlebar and controls **2rem** (32px).
- Content max widths used selectively (`max-w-2xl` for prose, `max-w-lg` for settings cards, `max-w-md` for empty models state).
- Home form stacks vertically on small widths, row on `sm+`; settings option groups same pattern.
- Models layout height: `100dvh` minus titlebar and two gutters.

### Whitespace Strategy

- Base unit **4px**; page padding and card padding use **gutter = 16px**.
- Section gaps 24–32px (`gap-6` / `gap-8`); control gaps 8–12px; form field stacks `gap-3` with label `gap-1`.
- Dense but not cramped: controls stay 32px tall with clear hit targets.

### Alignment & Visual Balance

- Left-aligned content hierarchy (kicker → title → description → framed workspace).
- Visual weight sits on borders and bold titles; color is the exception, not the rule.
- Frame shadow only on elevated panels (cards, dialogs, toasts, models shell) — not on the shell chrome or titlebar.
- Dialog and form actions align **end** (right in LTR).

### Responsive Behavior & Touch

- Desktop-first Tauri shell; routes still use responsive flex/grid collapses (`sm:`).
- Below 768px, multi-column content collapses to one column, secondary rails stack or become navigable panels, and horizontal page overflow is forbidden.
- Preserve a 14px minimum body size. Keep labels visible above fields; never rely on placeholder text as the only label.
- Existing desktop controls remain 32px high, icon buttons 28px square, and titlebar controls at least 40px wide. If a touch-first surface is introduced, increase its interactive targets to at least 44px without changing desktop density globally.
- Use `100dvh` for viewport-height layouts; never use `h-screen`.
- Reduced-motion: disable channel enter/exit, toast transitions, and page view-transition scrolls.

### Motion

- Page transitions: full-page vertical scroll via View Transitions API (scroll-up / scroll-down by sidebar order in `src/shell/nav.ts`), **320ms** custom ease (`cubic-bezier(0.32, 0.72, 0, 1)`) — transform only, no crossfade.
- Micro-interactions: 100–150ms color/opacity; channel list enter/exit translateY ±4px; dialog scale 100ms; toast stack 500ms transform.
- Sidebar width transition 200ms ease-out.

## 6. Design System Notes for Stitch Generation

### Language to Use

- “Sharp outline desktop utility,” “zero radius,” “frame border + offset hard shadow,” “near-black on-surface on paper white,” “warm charcoal dark mode,” “neutral secondary text,” “system sans,” “tooling density,” “collapsible sidebar shell,” “Material-style surface roles with outline chrome.”

### Color References

**Light:** Paper White `#ffffff`, Mist Gray `#f3f3f3`, Stone Gray `#e4e4e4`, Near Black `#161616`, Ash Gray `#555555`, Signal Blue `#0074ca`, Alert Red `#cc272e`.

**Dark:** Warm Charcoal `#141313`, Graphite Low `#1c1b1b`, Graphite High `#2b2a2a`, Warm Paper `#e5e2e1`, Soft Mist `#c4c7c7`, Outline Steel `#8e9192`, Soft Signal `#a2c9ff`, Soft Alert `#ffb4ab`.

### Component Prompts

1. **Shell:** “Desktop app chrome with 32px titlebar, collapsible 176px left sidebar of square nav cells, and a scrolling main pane with 16px padding on paper white (or warm charcoal in dark mode).”
2. **Frame card:** “Content card with 1px near-black border, no radius, 16px padding, and a hard 4px right/bottom offset shadow (shadow disabled in dark mode).”
3. **Outline control:** “32px-tall square button, 1px line border, surface fill, on-surface text; hover surface-2 fill.”
4. **Toast:** “Top-right stacked notification frame with hairline border, offset shadow, status icon, bold title, muted description, sliding in from the right.”

### Incremental Iteration

- Keep **radius at 0** — never introduce soft pills unless asked.
- Prefer border + offset shadow over blur/glass; dark mode may omit shadow entirely.
- When adding color, use **tertiary** for selection/accent only; **error** for destructive only.
- Match control height 32px and sidebar/rail proportions before inventing new density scales.
- Prefer M3 role names (`on-surface`, `surface-container-low`, `tertiary`, `error`) or project aliases (`surface-2`, `neutral`, `line`) — not ad-hoc hex in components.
- Source of truth for tokens: `src/styles.css`; shared control classes: `src/components/ui.ts`.

## 7. Anti-Patterns (Never Generate)

### Visual Language

- No rounded cards, pills, soft SaaS surfaces, glassmorphism, backdrop blur, neon glow, gradient text, or custom cursors.
- No pure-black or pure-white component utilities (`bg-black`, `text-black`, `bg-white`, `text-white`, `border-black`). Use semantic roles such as `bg-on-surface`, `text-surface`, `bg-surface`, and `border-line`. Alpha-only scrims must use `bg-overlay`.
- No ad-hoc colors, Tailwind default palette colors, or a second decorative accent. Signal Blue is the sole accent; Alert Red is reserved for errors and destructive actions.
- No overlapping elements, absolute-positioned content stacking, ornamental dot grids, or unbounded full-width content.
- No three-column equal-card feature rows. Use the product's rails, framed workspaces, two-column utility grids, dividers, or vertical sections only when they match the task.
- No generic dashboards, KPI cards, system-performance panels, or fabricated statistics. Never invent CPU usage, uptime, token counts, response times, percentages, user counts, or model capabilities. When a value is unknown, use a descriptive empty state or `[value]` placeholder.

### Typography & Content

- No Inter, external font CDNs, Material Symbols, icon fonts, generic serif faces, or decorative display type. Use the native sans and mono stacks.
- No emojis, fake brands, generic people names, `LABEL // YEAR` labels, or AI copy clichés such as “Elevate,” “Seamless,” “Unleash,” and “Next-Gen.”
- No uppercase button labels. Buttons use 14px body-tight text; uppercase is reserved for small labels and table headers.
- No filler instructions such as “Scroll to explore,” “Swipe down,” or bouncing direction indicators.
- No hardcoded user-facing English in implementation output. Use `react-i18next` and existing translation keys or add properly scoped keys.

### Components & Implementation

- No Tailwind CDN, inline Tailwind configuration, or redefinition of the default spacing scale. This project uses Tailwind CSS v4 through `@tailwindcss/vite` and `src/styles.css`.
- No class-based dark mode. Theme switching uses `data-theme="light|dark"` on `<html>` and semantic CSS variables.
- No invented utility names such as `hard-shadow`, `font-label-caps`, or `font-display-lg`. Use `shadow-frame` and registered `text-*` typography utilities.
- No raw HTML icon glyphs. Use the existing SVG icon component approach from `~icons/*`.
- No custom rebuilds of shared buttons, inputs, selects, switches, checkboxes, dialogs, or toasts. Reuse `src/components/ui.ts` and existing Base UI components.
- No focus treatment based only on color. Use the existing 2px inset `outline-on-surface` style.
- No circular loading spinners. Use skeletons shaped like the pending content and preserve layout dimensions.
- No generic “No data” dead ends. Empty states explain what is missing and provide the relevant existing action when one exists.
- No animation of `top`, `left`, `width`, or `height` for content transitions. Prefer `transform` and `opacity`; keep reduced-motion behavior intact. The sidebar's existing width transition is a deliberate shell exception.
- No routes or navigation items outside the real product map: Translate, Translate Profiles, Models, About, and Settings.

### Stitch Generation Guardrails

- Treat `src/styles.css` and `src/components/ui.ts` as authoritative when generated markup conflicts with this document.
- Preserve both light and dark semantic roles; never generate a light-only screen.
- Preserve square geometry (`0px` radius), 32px desktop controls, 1px line borders, and selective 4px offset frame shadows.
- Generated model configuration UI belongs inside the Models provider editor/dialog patterns. Do not place it over a fictional dashboard or surround it with unrelated navigation.
