---
name: LangNext App
colors:
  surface: '#ffffff'
  surface-dim: '#e4e4e4'
  surface-bright: '#ffffff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f3'
  surface-container: '#f3f3f3'
  surface-container-high: '#e4e4e4'
  surface-container-highest: '#e4e4e4'
  on-surface: '#161616'
  on-surface-variant: '#555555'
  inverse-surface: '#121212'
  inverse-on-surface: '#f8f8f8'
  outline: '#161616'
  outline-variant: '#e4e4e4'
  surface-tint: '#0074ca'
  primary: '#161616'
  on-primary: '#ffffff'
  primary-container: '#161616'
  on-primary-container: '#ffffff'
  inverse-primary: '#59aaf8'
  secondary: '#555555'
  on-secondary: '#ffffff'
  secondary-container: '#f3f3f3'
  on-secondary-container: '#161616'
  tertiary: '#0074ca'
  on-tertiary: '#ffffff'
  tertiary-container: '#0074ca'
  on-tertiary-container: '#ffffff'
  error: '#cc272e'
  on-error: '#ffffff'
  error-container: '#cc272e'
  on-error-container: '#ffffff'
  primary-fixed: '#e4e4e4'
  primary-fixed-dim: '#555555'
  on-primary-fixed: '#161616'
  on-primary-fixed-variant: '#555555'
  secondary-fixed: '#f3f3f3'
  secondary-fixed-dim: '#e4e4e4'
  on-secondary-fixed: '#161616'
  on-secondary-fixed-variant: '#555555'
  tertiary-fixed: '#59aaf8'
  tertiary-fixed-dim: '#0074ca'
  on-tertiary-fixed: '#ffffff'
  on-tertiary-fixed-variant: '#ffffff'
  background: '#ffffff'
  on-background: '#161616'
  surface-variant: '#f3f3f3'
  # Semantic app tokens (light theme defaults)
  ink: '#161616'
  muted: '#555555'
  line: '#161616'
  accent: '#0074ca'
  danger: '#cc272e'
  danger-ink: '#ffffff'
  code: '#f2f2f2'
  disabled: '#717171'
  overlay: '#00000033'
  shadow: '#0000001f'
  # Dark theme counterparts
  surface-dark: '#121212'
  surface-2-dark: '#222222'
  surface-3-dark: '#333333'
  ink-dark: '#f8f8f8'
  muted-dark: '#9e9e9e'
  accent-dark: '#59aaf8'
  danger-dark: '#d73337'
  code-dark: '#292929'
  overlay-dark: '#00000080'
typography:
  display-lg:
    fontFamily: system-ui
    fontSize: 30px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: '0'
  headline-md:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: '0'
  headline-sm:
    fontFamily: system-ui
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 28px
    letterSpacing: '0'
  title-dialog:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: '700'
    lineHeight: 24px
    letterSpacing: '0'
  body-base:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: '0'
  body-tight:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: '0'
  body-bold:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 20px
    letterSpacing: '0'
  label-caps:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.12em
  table-header:
    fontFamily: system-ui
    fontSize: 10px
    fontWeight: '400'
    lineHeight: 14px
    letterSpacing: 0.05em
  mono-key:
    fontFamily: ui-monospace
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: '0'
  code-inline:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: '0'
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

LangNext App is a **desktop utility shell** with a sharp, outline-first aesthetic — think technical workstation UI rather than consumer SaaS softness. Surfaces stay near-pure white (or deep charcoal in dark mode), ink is near-black, and every interactive frame is drawn with a **hairline black border** instead of rounded pills or floating shadows.

The mood is **calm, dense, and precise**: generous page gutters but compact control heights, zero border-radius, and a hard offset “frame shadow” (`0.25rem 0.25rem 0`) that makes cards and dialogs feel like cut-paper panels sitting on the canvas. Color is used sparingly — a cool blue accent for focus/checked states and a clear red for danger — so the hierarchy stays typographic and structural rather than chromatic.

## 2. Color Palette & Roles

### Primary Foundation

| Token | Hex | Role |
|:---|:---|:---|
| **Paper White** (`surface`) | `#ffffff` | App canvas, cards, inputs |
| **Mist Gray** (`surface-2`) | `#f3f3f3` | Hover fills, active nav, secondary surfaces |
| **Stone Gray** (`surface-3`) | `#e4e4e4` | Pressed fills, disabled solid buttons |
| **Near Black** (`ink` / `line`) | `#161616` | Primary text, borders, primary button fill |
| **Charcoal Night** (`surface` dark) | `#121212` | Dark-mode canvas |
| **Graphite** / **Slate** (dark surfaces) | `#222222` / `#333333` | Dark surface-2 / surface-3 |

### Accent & Interactive

| Token | Hex | Role |
|:---|:---|:---|
| **Signal Blue** (`accent`) | `#0074ca` | Checked switches, accent borders, interactive emphasis |
| **Sky Signal** (`accent` dark) | `#59aaf8` | Dark-mode accent |
| **Ink Solid** (`primary` button) | `#161616` on `#ffffff` text | Primary Save / commit actions |

### Typography & Text Hierarchy

| Token | Hex | Role |
|:---|:---|:---|
| **Near Black** (`ink`) | `#161616` | Headings, labels, body emphasis |
| **Ash Gray** (`muted`) | `#555555` | Secondary copy, inactive nav, placeholders |
| **Paper** (`ink` dark) | `#f8f8f8` | Dark-mode primary text |
| **Fog** (`muted` dark) | `#9e9e9e` | Dark-mode secondary text |
| **Disabled Gray** | `#717171` | Disabled borders and labels |

### Functional States

| Token | Hex | Role |
|:---|:---|:---|
| **Alert Red** (`danger`) | `#cc272e` | Destructive buttons, error text, close hover |
| **Danger Ink** | `#ffffff` | Text on danger fills |
| **Code Wash** (`code`) | `#f2f2f2` | Inline code backgrounds |
| **Scrim** (`overlay`) | `#000000` at 20% / 50% | Dialog backdrops (light / dark) |
| **Frame Shadow** | `#000000` at 12% (0 in dark) | Offset box-shadow for cards/dialogs |

Runtime theme switches via `data-theme="light|dark"` on `<html>`; tokens live as OKLCH CSS variables in `src/styles.css` and map into Tailwind utilities (`bg-surface`, `text-ink`, `border-line`, …).

## 3. Typography Rules

### Hierarchy & Weights

The stack is **system UI sans** (`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial`) with antialiased rendering. No custom webfonts — the product should feel native to the host OS.

| Role | Size / Line | Weight | Usage |
|:---|:---|:---|:---|
| **Display LG** | 30px / 36px | 700 | Rare large titles |
| **Headline MD** | 24px / 32px | 700 | Page titles (Home, Models, Settings, About) |
| **Headline SM** | 20px / 28px | 700 | Section headers |
| **Title Dialog** | 16px / 24px | 700 | Modal titles |
| **Body Base** | 14px / 24px | 400 | Supporting paragraphs |
| **Body Tight** | 14px / 20px | 400 | Controls, nav links, dense UI |
| **Body Bold** | 14px / 20px | 700 | Card titles, fieldset legends, table emphasis |
| **Label Caps** | 12px / 16px | 400, tracking `0.12em`, uppercase | Kickers / eyebrow labels |
| **Table Header** | 10px / 14px | 400, tracking `0.05em` | Column headers |
| **Mono / Code** | 14px or 12px mono | 400 | Inline code, technical keys |

### Spacing Principles

- Body copy sits on a relaxed 24px line; dense controls use 20px.
- Uppercase labels use wide tracking so small caps remain readable without bold weight.
- Prefer weight and color (ink vs muted) over size jumps for hierarchy.

## 4. Component Stylings

### Buttons

- **Shape:** `rounded-none` — perfectly square corners. Communicates tool-like precision.
- **Height:** fixed `control-height` = **32px**.
- **Outline (default):** 1px `line` border, `surface` fill, `ink` text; hover → `surface-2`, active → `surface-3`.
- **Primary solid:** `ink` fill, `surface` text, bold weight — used for Save/commit.
- **Danger solid:** `danger` fill/border, white text — destructive confirms.
- **Icon / ghost:** transparent, muted icon; hover soft surface fill.
- **Focus:** 2px ink outline inset (`-outline-offset-1`).
- **Disabled:** disabled border/text tokens; primary/danger fall back to surface-3.

### Cards & Containers

- **Frame card:** 1px `border-line`, `bg-surface`, padding `gutter` (16px), plus **shadow-frame** offset shadow.
- Stack cards in simple vertical gaps (`gap-6` / `gap-8` on pages).
- About page uses a **2-column grid** of frame cards for stack tech.

### Navigation

- **Layout:** Frameless custom **titlebar** (32px) + collapsible **left sidebar** (176px) + main content with 16px gutter.
- **Nav links:** full-width, 40px tall, muted text; hover soft fill; **active** = bordered cell with `surface-2` and ink text.
- **Settings** lives in a footer strip separated by a top border.
- Sidebar collapse animates width 200ms; closed state is `w-0` with no border.

### Inputs & Forms

- Square inputs/selects matching control height (32px), 1px line border, surface fill.
- Placeholder uses muted; focus uses inset ink outline (same as buttons).
- Checkboxes and radios are square (`rounded-none`) with ink accent.
- **Switch:** square track 36×20, thumb slides; checked state uses accent fill/border.

### Dialogs

- Backdrop: full-viewport overlay scrim with 150ms opacity fade.
- Popup: centered frame card (`w-96`), offset shadow, 100ms scale/opacity enter (`0.98` → `1`).
- Title bold; description muted; actions right-aligned outline/primary buttons.

### Domain-Specific: Models Workspace

- Nested **models rail** (~192px) listing provider “channels” with drag handles.
- Active channel: bold ink on surface-2; inactive muted.
- Enter/exit micro-animations (150ms / 120ms) on channel list items; respect reduced motion.
- Dense tables with tiny tracked headers; outline buttons for Add channel / manual model.

### Titlebar

- 32px drag strip with sidebar toggle, brand mark, and Windows-style min/max/close.
- Close hover turns **danger** red with white icon — only chromatic flourish in chrome.

## 5. Layout Principles

### Grid & Structure

- Full-height shell: `html/body/#root` height 100%, overflow hidden; **main** scrolls.
- Sidebar width token: **11rem** (176px); models secondary rail **12rem** (192px).
- Content max widths used selectively (`max-w-2xl` for prose, `max-w-lg` for settings cards).
- Home form stacks vertically on small widths, row on `sm+`.

### Whitespace Strategy

- Base unit **4px**; page padding and card padding use **gutter = 16px**.
- Section gaps 24–32px; control gaps 8–12px.
- Dense but not cramped: controls stay 32px tall with clear hit targets.

### Alignment & Visual Balance

- Left-aligned content hierarchy (title → description → framed workspace).
- Visual weight sits on black borders and bold titles; color is the exception, not the rule.
- Frame shadow only on elevated panels (cards, dialogs) — not on the shell chrome.

### Responsive Behavior & Touch

- Desktop-first Tauri shell; routes still use responsive flex/grid collapses.
- Minimum practical targets ~32px height; icon buttons ~28px square.
- Reduced-motion: disable channel enter/exit and page view-transition scrolls.

### Motion

- Page transitions: full-page vertical scroll via View Transitions API (scroll-up / scroll-down by sidebar order), 320ms custom ease — transform only, no crossfade.
- Micro-interactions: 100–150ms color/opacity; channel list enter/exit translateY ±4px.

## 6. Design System Notes for Stitch Generation

### Language to Use

- “Sharp outline desktop utility,” “zero radius,” “frame border + offset hard shadow,” “near-black ink on paper white,” “muted secondary text,” “system sans,” “tooling density,” “collapsible sidebar shell.”

### Color References

- Paper White `#ffffff`, Mist Gray `#f3f3f3`, Stone Gray `#e4e4e4`, Near Black `#161616`, Ash Gray `#555555`, Signal Blue `#0074ca`, Alert Red `#cc272e`, Charcoal Night `#121212`.

### Component Prompts

1. **Shell:** “Desktop app chrome with 32px titlebar, collapsible 176px left sidebar of square nav cells, and a scrolling main pane with 16px padding on paper white.”
2. **Frame card:** “Content card with 1px near-black border, no radius, 16px padding, and a hard 4px right/bottom offset shadow.”
3. **Outline control:** “32px-tall square button, 1px black border, white fill, dark text; hover light gray fill.”

### Incremental Iteration

- Keep **radius at 0** — never introduce soft pills unless asked.
- Prefer border + offset shadow over blur/glass.
- When adding color, use Signal Blue for selection/accent only; Alert Red for destructive only.
- Match control height 32px and sidebar proportions before inventing new density scales.

