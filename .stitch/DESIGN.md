# Design System: My Translator

## 1. Visual Theme & Atmosphere

A quiet desktop utility for translating text. The window has two surfaces: a **chrome band** that shares the native window material (Windows 11 Acrylic behind the title bar and sidebar) and an **opaque work panel** that floats over it with one rounded start-start corner. The panel stays flat white in light and near-black in dark, so the glass band reads as the frame, not as decoration.

Atmosphere: native, restrained, dense. Small text, tight 4-point rhythm, hairline borders. Color carries meaning, not decoration: neutral near-black primary buttons, one signal blue accent, and status tones only on state. One soft shadow exists in the whole interface, on toasts. No gradients, no glass inside the work panel, no card shadows.

Both themes are first class. Light chrome is warm cream; dark chrome is neutral charcoal. Every color comes from one theme token set and resolves in both modes.

## 2. Color Palette & Roles

Tokens live in `theme.json` as OKLCH custom properties. Hex values below are the sRGB equivalents for generation.

### Foundation surfaces

- **Paper White (`#ffffff` / `#0a0a0a`)**: work panel and page background.
- **Card White (`#ffffff` / `#171717`)**: card, dialog, popover and menu surface.
- **Subtle Wash (`#f9fafb` / `#171717`)**: inset result cards and secondary panels.
- **Control Field (`#ffffff` / `#262626`)**: control well inside a card.
- **Muted Fill (`#f5f5f5` / `#262626`)**: dialog footers, table header, hover wash.
- **Overlay Scrim (`#000000` at 40%, both modes)**: dialog backdrop.
- **Warm Chrome Cream (`#faf0e3` / `#171717`)**: the glass band behind the title bar and sidebar. Light is warm on purpose; dark stays neutral.

### Structure

- **Hairline Border (`#e5e5e5` / `#ffffff` at 10%)**: every card, table, dialog and divider. It is the only depth device on flat surfaces.
- **Input Border (`#e5e5e5` / `#ffffff` at 15%)**: resting field outline, one step stronger than a hairline.
- **Focus Ring (`#a1a1a1` / `#737373`)**: 2-point focus ring and focused field outline.

### Typography hierarchy

- **Ink (`#0a0a0a` / `#fafafa`)**: primary text and icon tint.
- **Slate Muted (`#737373` / `#a1a1a1`)**: metadata, placeholders, timestamps, secondary subtitles.

### Interactive

- **Carbon Primary (`#171717` / `#e5e5e5`)**: solid primary buttons on `#fafafa` / `#171717` text. In dark mode the pair inverts.
- **Neutral Secondary (`#f5f5f5` / `#262626`)**: secondary fills and the shared hover/pressed wash (`accent`).
- **Signal Blue (`#155dfc` / `#348bff`)**: the single brand accent. Brand-ghost buttons, selected brand marks, inline brand links.
- **Signal Blue Soft (`#e8f3ff` / `#102441`)**: brand hover and selected wash.

### Functional states

- **Success Green (`#008236` / `#00bc7d`)**: enabled channel, saved state.
- **Warning Amber (`#d08700` / `#fe9a00`)**: unsaved draft, insecure `http://` warning.
- **Destructive Red (`#e7000b` / `#ff6467`)**: delete, failure, validation error.
- **Badge fills**: the state color at 15% opacity over a 40% border, with the state color as text.

## 3. Typography Rules

One family: the platform system UI font. The app registers no font face. A monospace family appears only for numeric, key, and credential readouts.

Scale in NSH points:

| Role          | Size   | Weight | Use                                                         |
| ------------- | ------ | ------ | ----------------------------------------------------------- |
| Footnote      | `12pt` | `500`  | badges, table headers, timestamps, helper text              |
| Body          | `14pt` | `500`  | the workhorse: buttons, labels, inputs, rows, dialog titles |
| Body Strong   | `14pt` | `600`  | selected navigation label                                   |
| Section       | `16pt` | `600`  | card section headings                                       |
| Subheading    | `18pt` | `600`  | detail-pane titles, page subtitles                          |
| Heading       | `20pt` | `600`  | section titles                                              |
| Display       | `24pt` | `700`  | page titles                                                 |
| Display Large | `30pt` | `700`  | single empty-state headline                                 |

Rules:

- Body text is `14pt` and muted metadata is `12pt`. Do not raise body copy to `16pt` for emphasis; use weight.
- Weight budget: `500` for controls and labels, `600` for headings and section titles, `700` for page titles only. Nothing is lighter than `400`.
- The translation source uses a measurement ladder of `14 / 16 / 20 / 24pt` and steps down until six rows of body text fit the budget.
- Letter spacing stays default. Uppercase is not used.

## 4. Component Stylings

- **Button**: `36pt` tall (`sm` `32pt`, `xs` `24pt`), horizontal padding `16pt` (`sm` `12pt`, `xs` `8pt`), `8pt` radius, `1pt` border, `14pt` medium label, `8pt` gap for a leading icon. Variants: primary (Carbon fill), secondary (neutral fill), outline (surface with input border), ghost (no border), brand-ghost (Signal Blue text, soft blue hover), destructive (red fill or red border). Hover raises the fill one step; press deepens it again; press also scales to `0.95`. Cards and rows use a larger variant: `min-h-14` (`56pt`), `12pt` radius, `16pt` padding.
- **Card**: `24pt` padding, `20pt` gap between children, `12pt` radius, `1pt` hairline border, card surface. The subtle variant drops padding to `0` and takes the subtle wash.
- **Input and Select**: `36pt` tall (`32pt` compact), `8pt` radius, `1pt` input border, `12pt` leading padding, transparent inner field. Focus adds a `2pt` ring plus the ring border. Bad values keep the border; errors show as text, not as red outlines.
- **Switch**: full-row control, `44pt` track, `20pt` thumb with a small shadow, fully rounded, `2pt` track padding. Off is the input border tone, on is the primary tone. The label sits at the leading edge and the track at the trailing edge; the whole row is the hit target and the row washes on hover.
- **Badge**: `6pt` radius, `6pt` / `2pt` padding, `12pt` medium text, transparent state fill at 15% over a 40% border. Never a dot without a label.
- **Dialog**: `16pt` radius, `1pt` border, dialogs come in `384 / 448 / 512pt` widths. Borderless header at `20pt` / `12pt` padding with a `14pt` medium title and a bottom hairline; body scrolls at `20pt` padding with a `16pt` gap; footer is the muted fill with a top hairline and right-aligned actions. Backdrop is the 40% scrim.
- **Table**: `8pt` radius container with a `1pt` border. Header row is the muted fill at 60% with `12pt` medium labels and a bottom hairline. Body rows are `12pt` / `8pt` padded with hairline dividers and no divider on the last row.
- **Toast**: `320pt` wide, `12pt` radius, `14pt` padding, popover surface, hairline border, the one soft shadow. Stacked bottom-center `16pt` above the edge, three visible, with a dismiss icon at the trailing edge.
- **Navigation item**: `32pt` minimum height, `8pt` radius, `8pt` / `6pt` padding, `14pt` label at 80% ink that reaches full ink on hover. The selected item holds the neutral wash with a medium label. Hover is a 60% wash, press the full wash.
- **Split rail**: master-detail pages use a `240pt` rail (`192pt` below `860pt` wide), resizable between `180pt` and `360pt`, with the detail pane always keeping at least `400pt`. The divider is a `1pt` hairline, not a bar.

## 5. Layout Principles

- **Spatial grid**: `4pt` base unit, `8pt` preferred step. Gaps cluster at `4`, `8`, `12`, `16`, `20pt`; card padding is `24pt`; page padding is `32pt`.
- **Window**: default `1040 x 720pt`, minimum `720 x 520pt`, title bar `42pt` tall with hidden native chrome.
- **Frame**: the title bar and sidebar draw one band with no separator. The work panel fills the remaining area, takes `12pt` on its start-start corner only, and clips its content so the band shows through the curve. No border between band and panel.
- **Page column**: one shared container, `max-w-5xl` (`1024pt`) wide, centered, `32pt` padding, `32pt` vertical gap between sections. A page never sets its own width, padding, or scrolling, so a destination switch moves nothing.
- **Split pages**: master-detail destinations fill the panel edge to edge, with a fixed `56pt` header bar in each pane and their titles on one spine.
- **Responsive behavior**: `860pt` is the single content breakpoint; below it, two-column field rows stack and the rail narrows. The layout stays one column from `720pt` up; nothing is hidden.
- **Density**: rows are `32-56pt` tall, controls `32-36pt`. Prefer density over whitespace; this is a utility that shows lists and forms, not a marketing page.

## 6. Design System Notes for Stitch Generation

- **Atmosphere keywords**: native desktop utility, quiet neutrality, dense 4-point rhythm, hairline structure, one signal blue accent, warm cream glass chrome in light and neutral charcoal in dark, flat opaque work panel with a single rounded corner, no decorative shadows.
- **Canonical colors**: Paper White `#ffffff`, Card White `#171717` (dark), Ink `#0a0a0a`, Slate Muted `#737373`, Hairline `#e5e5e5`, Carbon Primary `#171717`, Signal Blue `#155dfc`, Signal Blue Soft `#e8f3ff`, Success `#008236`, Warning `#d08700`, Destructive `#e7000b`, Warm Chrome Cream `#faf0e3`.
- **Prompt: settings page**: a centered `1024pt` column with `32pt` padding, a `24pt` bold page title, then cards with `12pt` radius, hairline borders and `24pt` padding. Each card holds a `16pt` semibold section heading, then full-row switches at `32pt` height with the label left and a `44pt` track right, separated by hairline dividers. Neutral surfaces only; no accent except the enabled track.
- **Prompt: master-detail list**: a resizable `240pt` left rail with a `56pt` header holding a title and one icon button, and a scrollable list of `48pt` rows, each with a leading status icon lane, a `14pt` medium name, a `12pt` muted provider subtitle, and a neutral wash on selection. The right pane is a `56pt` header with the record name and a switch, then bordered cards for connection fields and a table with a muted header.
- **Prompt: translate panel**: an empty state with a `30pt` bold headline and a muted hint, an input row of `36pt` height with `8pt` radius, and a muted footer row of `12pt` metadata with icon buttons of `32pt`. Neutral palette, one blue brand-ghost action.
