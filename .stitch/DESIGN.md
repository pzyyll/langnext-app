# Design System: My Translator

## 1. Visual Theme & Atmosphere

A quiet desktop utility for translating text. The window has a **warm stone chrome frame** behind the title bar and narrow navigation rail, an **off-white master column (`#F8F7F4`)** for split-pane lists, and a **pure white detail surface (`#FFFFFF`)** holding elevated cards with crisp `1pt` warm borders and soft layered shadows. In dark mode, surfaces step cleanly through warm charcoal layers.

Atmosphere: tactile, refined, calm. Clean spacing, warm stone boundaries (`#E3DFD7`), and crisp depth hierarchy between the frame, master rail, work surface, and elevated cards. Color carries meaning, not decoration: deep carbon primary buttons (`#18181B`), one signal blue accent, and emerald/amber/red status tones only on state.

Both themes are first class. Light chrome is warm stone beige (`#EBE8E1` / `#F0EDE6`) with warm off-white rails (`#F8F7F4`) and pure white elevated cards (`#FFFFFF`); dark surfaces step across warm charcoal shades with crisp hairline borders and dark-adapted card shadows. Every color comes from one theme token set and resolves in both modes.

## 2. Color Palette & Roles

Tokens live in `theme.json` as OKLCH custom properties. Hex values below are the sRGB equivalents for reference.

### Foundation surfaces

- **Paper White (`#FFFFFF` / `#10100F`)**: detail pane and page background (`background`).
- **Card White (`#FFFFFF` / `#1B1A18`)**: elevated cards, selected rail cards, and dialogs (`card`).
- **Floating Popover (`#FAF8F5` / `#1C1A18`)**: select lists, menus, and toasts — the warm off-white popup surface (`popover`).
- **Warm Column (`#F8F7F4` / `#141412`)**: master list columns for Channels, Presets, and Settings (`surface-rail`).
- **Stone Subtle (`#FBFBFA` / `#1F1E1C`)**: table headers, subtle inset cards, and Quick Translate footer (`surface-subtle`).
- **Stone Control Well (`#FBFBFA` / `#22211F`)**: resting input, select, choice card, and keycap surfaces (`surface-control`).
- **Warm Muted Fill (`#F3F1EC` / `#252422`)**: dialog footers, badges, icon tiles, and quiet hover washes (`muted`, `secondary`).
- **Warm Hover Wash (`#EFECE5` / `#292826`)**: pointer hover and control focus wash (`accent`).
- **Row Selection Wash (`#E7E5E4` / `#2F2D2C`)**: dropdown row hover (`selection/50`) and selected or checked rows (`selection/70`) (`selection`).
- **Overlay Scrim (`#000000` at 40%, both modes)**: dialog backdrop (`overlay`).
- **Warm Stone Chrome (`#F0EDE6` / `#0D0D0C`)**: title bar and left navigation rail frame (`sidebar`), paired with crisp elevated active navigation tiles (`sidebar-accent`).

### Structure

- **Warm Hairline Border (`#E3DFD7` / `#FFFFFF` at 11%)**: cards, tables, dialogs, split headers, and dividers (`border`).
- **Input Border (`#E3DFD7` / `#FFFFFF` at 16%)**: resting field and outline-button border (`input`).
- **Focus Ring (`#9B9890` / `#787670`)**: 2-point keyboard focus ring and focused input outline (`ring`).

### Typography hierarchy

- **Ink (`#1E1E1E` / `#F5F4F0`)**: primary text and icon tint (`foreground`).
- **Warm Stone Muted (`#6B6862` / `#A8A59E`)**: metadata, placeholders, timestamps, subtitles, and field labels (`muted-foreground`).

### Interactive

- **Carbon Primary (`#18181B` / `#E9E7E2`)**: solid primary action buttons (`+ Add Model`, `+ Add Channel`, `Save`) and active switch tracks (`primary`).
- **Neutral Secondary (`#F3F1EC` / `#252422`)**: secondary fills (`secondary`).
- **Signal Blue (`#155DFC` / `#348BFF`)**: single brand accent for Quick Translate active toggles (`brand`).
- **Signal Blue Soft (`#E8F3FF` / `#102441`)**: brand selected wash (`brand-soft`).

### Functional states

- **Emerald Success (`#059669` / `#10B981`)**: enabled status checkmarks, connection OK badges (`success`).
- **Warning Amber (`#D08700` / `#FE9A00`)**: unsaved draft, insecure `http://` warning (`warning`).
- **Destructive Red (`#E7000B` / `#FF6467`)**: delete, failure, validation error (`destructive`).
- **Badge fills**: state color at 15% opacity over a 40% border, with state color as text.

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

- **Button**: `36pt` tall (`sm` `32pt`, `xs` `24pt`), horizontal padding `16pt` (`sm` `12pt`, `xs` `8pt`), `12pt` radius (`8pt` on `xs`, `icon-sm`, `icon-xs`), `1pt` border, `14pt` medium label, `8pt` gap for a leading icon. Variants: primary (Carbon fill with subtle `shadow-control`), secondary (neutral fill with `shadow-control`), outline (card surface with input border and `shadow-control`), ghost (no border), brand-ghost (Signal Blue text, soft blue hover), destructive (red fill or red border with `shadow-control`). Hover raises the fill one step; press deepens it again; press also scales to `0.95`. Cards and rows use a larger variant: `min-h-14` (`56pt`), `12pt` radius, `16pt` padding.
- **Card**: `24pt` padding, `20pt` gap between children, `16pt` radius (`rounded-2xl`), `1pt` hairline border, card surface with layered `shadow-card` (`dark:shadow-card-dark`). The subtle variant drops padding to `0`, uses `12pt` radius (`rounded-xl`), and takes the `surface-subtle` fill.
- **Input and Select**: `36pt` tall (`32pt` compact), `12pt` radius (`rounded-xl`), `1pt` input border, `surface-control` fill that lifts to `card` on focus, `12pt` leading padding, transparent inner field. Focus adds a `2pt` ring plus the ring border. Bad values keep the border; errors show as text, not as red outlines.
- **Dropdown Popups (Select and Menu)**: `16pt` radius (`rounded-2xl`), `1pt` border, warm popover fill, soft `shadow-card` (`dark:shadow-card-dark`), `4pt` padding (`p-1`). Items take a `2pt` gap (`my-px` per row, leaving a `5pt` outer inset), `12pt` concentric radius (`rounded-xl`), `12pt` / `8pt` padding (`px-3 py-2`, `36pt` tall), a `selection/50` focus/hover wash, and a `selection/70` selected/checked wash with a trailing check icon in Select.
- **Switch**: full-row or inline control; default track `40pt` wide with `16pt` thumb (`20pt` total height); compact (`sm`) track `32pt` wide with `14pt` thumb (`18pt` total height) for dense table rows. Off is the input border tone, on is the primary tone. When labeled, the label sits at the leading edge and the track at the trailing edge.
- **Badge**: `6pt` radius (`rounded-full` when `pill` is set), `6pt` / `2pt` padding, `12pt` medium text, transparent state fill at 15% over a 40% border, with optional leading status dot. Never a dot without a label.
- **Dialog**: `16pt` radius, `1pt` border, elevated `shadow-xl`, widths `384 / 448 / 512pt`. Header at `20pt` / `12pt` padding with a `14pt` medium title and a bottom hairline; body scrolls at `20pt` padding with a `16pt` gap; footer is the muted fill with a top hairline and right-aligned actions. Backdrop is the 40% scrim.
- **Table**: `12pt` radius container (`rounded-xl`) on `card` surface with a `1pt` border. Header row uses `surface-subtle` with `12pt` medium labels and a bottom hairline. Body rows are `16pt` / `12pt` padded with hairline dividers and no divider on the last row.
- **Toast**: `320pt` wide, `12pt` radius, `14pt` padding, popover surface, hairline border, soft `shadow-lg`. Stacked bottom-center `16pt` above the edge, three visible, with a dismiss icon at the trailing edge.
- **Navigation item**: `32pt` minimum height, `12pt` radius, `10pt` / `6pt` padding, `14pt` label at 80% ink that reaches full ink on hover. Selected rail items (channels, presets, settings sections) lift onto `bg-card` with `border-border` and `shadow-card` over the `surface-rail` rail column.
- **Split rail**: master-detail pages use a `240pt` rail (`192pt` below `860pt` wide), resizable between `180pt` and `360pt`, with the detail pane always keeping at least `400pt`. The rail surface uses `surface-rail` (`#F8F7F4`), the headers stay borderless aligned with the detail header, and the split divider is a `1pt` hairline.

## 5. Layout Principles

- **Spatial grid**: `4pt` base unit, `8pt` preferred step. Gaps cluster at `4`, `8`, `12`, `16`, `20pt`; card padding is `24pt`; page padding is `32pt`.
- **Window**: default `1040 x 720pt`, minimum `720 x 520pt`, title bar `42pt` tall with hidden native chrome.
- **Frame**: the title bar and sidebar draw one band with no separator. The work panel fills the remaining area, takes `12pt` on its start-start corner only, and clips its content so the band shows through the curve. No border between band and panel.
- **Page column**: one shared container, `max-w-5xl` (`1024pt`) wide, centered, `32pt` padding, `32pt` vertical gap between sections. A page never sets its own width, padding, or scrolling, so a destination switch moves nothing.
- **Split pages**: master-detail destinations fill the panel edge to edge, with a fixed `56pt` header bar in each pane and their titles on one spine.
- **Responsive behavior**: `860pt` is the single content breakpoint; below it, two-column field rows stack and the rail narrows. The layout stays one column from `720pt` up; nothing is hidden.
- **Density**: rows are `32-56pt` tall, controls `32-36pt`. Prefer density over whitespace; this is a utility that shows lists and forms, not a marketing page.

## 6. Design System Notes for Stitch Generation

- **Atmosphere keywords**: warm stone desktop utility, tactile elevated paper cards, crisp 4-point rhythm, warm hairline structure (`#E3DFD7`), soft card shadows, warm off-white master column (`#F8F7F4`), carbon primary buttons (`#18181B`), one signal blue accent.
- **Canonical colors**: Paper White `#ffffff`, Warm Column `#F8F7F4`, Stone Control `#FBFBFA`, Ink `#1E1E1E`, Warm Stone Muted `#6B6862`, Warm Hairline `#E3DFD7`, Carbon Primary `#18181B`, Signal Blue `#155DFC`, Signal Blue Soft `#E8F3FF`, Emerald Success `#059669`, Warning `#D08700`, Destructive `#E7000B`, Warm Stone Chrome `#F0EDE6`.
- **Prompt: settings page**: a centered `1024pt` column with `32pt` padding, a `24pt` bold page title, then elevated `16pt`-radius cards with warm hairline borders, soft card shadows, and `24pt` padding. Each card holds a `16pt` semibold section heading, then full-row switches with the label left and a `40pt` track right, separated by hairline dividers.
- **Prompt: master-detail list**: a resizable `240pt` warm off-white (`#F8F7F4`) left rail with a `56pt` borderless header holding a title, count pill, and primary `+` icon button, and a scrollable list of `12pt`-radius rows where the selected item lifts onto a pure white bordered card with a soft shadow. The right pane is a `56pt` borderless header with a badged provider icon, record name, and `启用 [Switch]`, then `16pt`-radius shadowed cards for connection fields (`12pt`-radius inputs/selects) and a `12pt`-radius table with a light stone header.
- **Prompt: translate panel**: an empty state with a `30pt` bold headline and a muted hint, an input row of `36pt` height with `12pt` radius, and a muted footer row of `12pt` metadata with icon buttons of `32pt`. Warm neutral palette, one blue brand-ghost action.

## 7. Motion Inventory

Recorded for the Google voice settings before editing its TSX. Every entry reuses an existing token from `components/motion.ts`; the change adds no decorative motion.

| State change                                                            | Tool and reduced motion                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls hover, press, or gain focus                                    | Existing input, button, and select state styles. Buttons keep `motion.pressScale`; the shared slider thumb uses `motion.navigationFeedback` for its color change. `motion-reduce` removes the transition and the press scale. |
| Selected family, locale, or voice changes                               | Existing Select selection and focus feedback. The family label, pricing lines, and preview voice label change immediately; no text animation and no form movement.                                                            |
| Detail enters, picker opens or closes, overrides dialog opens or closes | `motion.pageEnter` for the channel detail, the `AppDialog` fade, and the existing Select popup transition. Reduced motion removes the page and overlay motion.                                                                |
| Search results, field errors, and unavailable state                     | Update immediately so the keyboard position stays put. The slider and preview action positions stay fixed when capability or playback changes.                                                                                |
| Slider pointer release, arrow key, or accessibility step                | The thumb follows the value directly. No spring, inertia, or value animation.                                                                                                                                                 |
| Play sample, Cancel, Stop, completion, save confirmation                | The existing phase label and button state change, plus the existing save toast transition. Reduced motion removes the toast movement. No waveform or background animation.                                                    |

### Quick Translate Markdown

- Hover, press, and focus: Use the shared brand-ghost button and `motion.pressScale`. Reduced motion removes the transition and press scale.
- Markdown on or off: Swap the outline and filled icons in place and change the selected background and tint. Keep focus on the button. Reflow the result in the existing scroll region, with no enter or exit animation.
- Streaming and completion: Update the result in place and keep the current scroll region. Do not add a caret, progress animation, or new overlay. Reduced motion does not change the text updates.

### Google Cloud Translation presets and card

Recorded before editing the Presets and Quick Translate TSX. Every entry reuses an existing token from `components/motion.ts`; the change adds no decorative motion.

| State change                                                         | Tool and reduced motion                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Picker or discard dialog opens and closes                            | `AppDialog` with `motion.dialogAnimation`; instant with reduced motion. Focus returns to the trigger or moves to the new draft name.                                                                |
| Option and action hover or press; rail selection; enabled switch     | `motion.pressScale`, `motion.navigationFeedback`, and `motion.switchThumb` from the existing controls. Reduced motion removes transitions and scale; focus stays visible.                           |
| Draft and saved editor, key placeholder, validation, save and delete | Existing editor swap, field feedback, and save toast (`motion.toastTransition`, `motion.toastStack`). Form layout and errors do not animate. Reduced motion removes toast movement.                 |
| Card picker and translation result                                   | Existing Select popup transition and loading/result states. Loading is replaced by the complete result or inline error. No streaming, progress animation, gesture, sound, or new layout transition. |

### Language Detection channels

Recorded before editing the Language Detection TSX. Every entry reuses an existing token from `components/motion.ts` or native row drag timing; the change adds no decorative motion.

| State change                                                        | Tool and reduced motion                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List and detail entrance                                            | Existing `motion.pageEnter` (`opacity: [0, 1]`, 200ms easeOut). Instant with reduced motion.                                                                                    |
| Outline add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `DetectionChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                         |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation                                | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`). Reduced motion removes toast movement.                                                             |

### Text-to-speech channels

Recorded before editing the Text-to-Speech settings TSX to match the Language Detection and OCR channel picker. Every entry reuses an existing token from `components/motion.ts` or native row drag timing; the change adds no decorative motion.

| State change                                                        | Tool and reduced motion                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List and detail entrance                                            | Existing `motion.pageEnter` (`opacity: [0, 1]`, 200ms easeOut). Instant with reduced motion.                                                                                    |
| Outline add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `TtsChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                               |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation, sample playback               | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`); the existing preview phase and playback controls. Reduced motion removes toast movement.           |

### OCR channels

Recorded before editing the OCR settings TSX to match the Language Detection channel picker. Every entry reuses an existing token from `components/motion.ts` or native row drag timing; the change adds no decorative motion.

| State change                                                        | Tool and reduced motion                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List and detail entrance                                            | Existing `motion.pageEnter` (`opacity: [0, 1]`, 200ms easeOut). Instant with reduced motion.                                                                                    |
| Outline add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `OcrChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                               |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation                                | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`). Reduced motion removes toast movement.                                                             |

### Channel connection test

Recorded before editing the channel editor header. Every entry reuses an existing token or the shared tooltip.

| State change                                                      | Tool and reduced motion                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection result appears or clears beside the Connection heading | Instant swap. The existing success or error toast still carries `motion.toastTransition` and `motion.toastStack`. Reduced motion does not change the swap. |
| A truncated status badge is hovered                               | The shared `buildTooltip` bubble and its `motion.tooltip` transition. Instant with reduced motion.                                                         |
| Test button label switches between Test connection and Testing…   | Instant label and disabled-state swap; the button keeps `motion.pressScale`. Reduced motion removes the press scale.                                       |

### Warm Stone Theme & Elevated Card Styling

Recorded before editing `theme.json`, `nsh.json`, `components/ui/*`, and the workspace screens. Every entry reuses existing motion tokens in `components/motion.ts`.

| State change                                                              | Tool and reduced motion                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar destination, rail row, button, select, or input hover/focus/press | Existing `motion.navigationFeedback` (150ms easeOut color/wash) and `motion.pressScale` (0.95 active scale, 150ms easeOut). Reduced motion removes transitions/scale. |
| Rail selection changes (channels, presets, settings sections)             | Instant surface swap onto `bg-card` with `shadow-card` (`dark:shadow-card-dark`) and `border-border` over `bg-surface-rail`. Reduced motion keeps the swap.           |
| Inline and row switches toggle                                            | Existing `motion.switchThumb` (150ms easeOut thumb translation) and `motion.navigationFeedback` track color transition. Reduced motion makes the change instant.      |
| Card, table row, or dialog reveal                                         | Elevated cards rest statically with `shadow-card`; dialogs keep `motion.dialogAnimation` (`"fade"`); popups keep `motion.popup`. Reduced motion removes fade/slide.   |
