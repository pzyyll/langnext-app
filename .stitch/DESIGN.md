# Design System: My Translator

## 1. Visual Theme & Atmosphere

A quiet desktop utility for translating text. The window has a **cool slate chrome frame** behind the title bar and narrow navigation rail, an **ice-slate master column (`#F3F7FA`)** for split-pane lists, and a **pure white detail surface (`#FFFFFF`)** holding elevated cards with crisp `1pt` slate borders and soft layered shadows. In dark mode, surfaces step cleanly through deep slate layers.

Atmosphere: tactile, refined, calm. Clean spacing, cool slate boundaries (`#DDE4ED`), and crisp depth hierarchy between the frame, master rail, work surface, and elevated cards. Color carries meaning, not decoration: deep slate-900 primary buttons (`#0F172B`), one signal blue accent, and emerald/amber/red status tones only on state.

Both themes are first class. Light chrome is cool slate (`#E6ECF4`) with ice-slate rails (`#F3F7FA`) and pure white elevated cards (`#FFFFFF`); dark surfaces step across deep slate shades (`#080C12` to `#1E252F`) with crisp hairline borders and dark-adapted card shadows. Every color comes from one theme token set and resolves in both modes.

## 2. Color Palette & Roles

Tokens live in `theme.json` as OKLCH custom properties. Hex values below are the sRGB equivalents for reference.

### Foundation surfaces

- **Paper White (`#FFFFFF` / `#0C111A`)**: detail pane and page background (`background`).
- **Card White (`#FFFFFF` / `#171E27`)**: elevated cards, selected rail cards, and dialogs (`card`).
- **Floating Popover (`#F8FAFC` / `#192029`)**: select lists, menus, and toasts — the cool slate-50 popup surface (`popover`).
- **Slate Column (`#F3F7FA` / `#121720`)**: master list columns for Channels, Presets, and Settings (`surface-rail`).
- **Slate Subtle (`#F6F9FC` / `#1C232C`)**: table headers, subtle inset cards, and Quick Translate footer (`surface-subtle`).
- **Slate Control Well (`#F9FBFD` / `#1E252F`)**: resting input, select, choice card, and keycap surfaces (`surface-control`).
- **Slate Muted Fill (`#EEF2F7` / `#212832`)**: dialog footers, badges, icon tiles, and quiet hover washes (`muted`, `secondary`).
- **Slate Hover Wash (`#E8EEF5` / `#262D38`)**: pointer hover and control focus wash (`accent`).
- **Row Selection Wash (`#E0E7F0` / `#2C3542`)**: dropdown row hover (`selection/50`) and selected or checked rows (`selection/70`) (`selection`).
- **Overlay Scrim (`#000000` at 40%, both modes)**: dialog backdrop (`overlay`).
- **Cool Slate Chrome (`#E6ECF4` / `#080C12`)**: title bar and left navigation rail frame (`sidebar`), paired with crisp elevated active navigation tiles (`sidebar-accent`).

### Structure

- **Slate Hairline Border (`#DDE4ED` / `#FFFFFF` at 11%)**: cards, tables, dialogs, split headers, and dividers (`border`).
- **Input Border (`#DAE1EB` / `#FFFFFF` at 16%)**: resting field and outline-button border (`input`).
- **Focus Ring (`#8493AA` / `#6E7B8E`)**: 2-point keyboard focus ring and focused input outline (`ring`).

### Typography hierarchy

- **Slate Ink (`#0F172B` / `#F0F3F6`)**: primary text and icon tint (`foreground`).
- **Slate Muted (`#5A697E` / `#9BA6B5`)**: metadata, placeholders, timestamps, subtitles, and field labels (`muted-foreground`).

### Interactive

- **Slate 900 Primary (`#0F172B` / `#E5EAF0`)**: solid primary action buttons (`+ Add Model`, `+ Add Channel`, `Save`) and active switch tracks (`primary`).
- **Neutral Secondary (`#EEF2F7` / `#212832`)**: secondary fills (`secondary`).
- **Signal Blue (`#2563EB` / `#348BFF`)**: single brand accent for Quick Translate active toggles (`brand`).
- **Signal Blue Soft (`#E6F1FF` / `#122644`)**: brand selected wash (`brand-soft`).

### Functional states

- **Emerald Success (`#079669` / `#10B981`)**: enabled status checkmarks, connection OK badges (`success`).
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

- **Button**: `36pt` tall (`sm` `32pt`, `xs` `24pt`), horizontal padding `16pt` (`sm` `12pt`, `xs` `8pt`), `12pt` radius (`8pt` on `xs`, `icon-sm`, `icon-xs`), `1pt` border, `14pt` medium label, `8pt` gap for a leading icon. Variants: primary (Slate-900 fill with subtle `shadow-control`), secondary (neutral fill with `shadow-control`), outline (card surface with input border and `shadow-control`), ghost (no border), brand-ghost (Signal Blue text, soft blue hover), destructive (red fill or red border with `shadow-control`). Hover raises the fill one step; press deepens it again; press also scales to `0.95`. Cards and rows use a larger variant: `min-h-14` (`56pt`), `12pt` radius, `16pt` padding.
- **Card**: `24pt` padding, `20pt` gap between children, `16pt` radius (`rounded-2xl`), `1pt` hairline border, card surface with layered `shadow-card` (`dark:shadow-card-dark`). The subtle variant drops padding to `0`, uses `12pt` radius (`rounded-xl`), and takes the `surface-subtle` fill.
- **Input and Select**: `36pt` tall (`32pt` compact), `12pt` radius (`rounded-xl`), `1pt` input border, `surface-control` fill that lifts to `card` on focus, `12pt` leading padding, transparent inner field. Focus adds a `2pt` ring plus the ring border. Bad values keep the border; errors show as text, not as red outlines.
- **Dropdown Popups (Select and Menu)**: `16pt` radius (`rounded-2xl`), `1pt` border, cool slate popover fill, soft `shadow-card` (`dark:shadow-card-dark`), `4pt` padding (`p-1`). Items take a `2pt` gap (`my-px` per row, leaving a `5pt` outer inset), `12pt` concentric radius (`rounded-xl`), `12pt` / `8pt` padding (`px-3 py-2`, `36pt` tall), a `selection/50` focus/hover wash, and a `selection/70` selected/checked wash with a trailing check icon in Select. A Select whose options name an engine or provider repeats the trigger's `12pt` mark in a centered `12pt` slot, `6pt` before each row's label.
- **Switch**: full-row or inline control; default track `40pt` wide with `16pt` thumb (`20pt` total height); compact (`sm`) track `32pt` wide with `14pt` thumb (`18pt` total height) for dense table rows. Off is the input border tone, on is the primary tone. When labeled, the label sits at the leading edge and the track at the trailing edge.
- **Badge**: `6pt` radius (`rounded-full` when `pill` is set), `6pt` / `2pt` padding, `12pt` medium text, transparent state fill at 15% over a 40% border, with optional leading status dot. Never a dot without a label.
- **Dialog**: `16pt` radius, `1pt` border, elevated `shadow-xl`, widths `384 / 448 / 512pt`. Header at `20pt` / `12pt` padding with a `14pt` medium title and a bottom hairline; body scrolls at `20pt` padding with a `16pt` gap; footer is the muted fill with a top hairline and right-aligned actions. Backdrop is the 40% scrim.
- **Table**: `12pt` radius container (`rounded-xl`) on `card` surface with a `1pt` border. Header row uses `surface-subtle` with `12pt` medium labels and a bottom hairline. Body rows are `16pt` / `12pt` padded with hairline dividers and no divider on the last row.
- **Toast**: `320pt` wide, `12pt` radius, `14pt` padding, popover surface, hairline border, soft `shadow-lg`. Stacked bottom-center `16pt` above the edge, three visible, with a dismiss icon at the trailing edge.
- **Navigation item**: `32pt` minimum height, `12pt` radius, `10pt` / `6pt` padding, `14pt` label at 80% ink that reaches full ink on hover. Selected rail items (channels, presets, settings sections) lift onto `bg-card` with `border-border` and `shadow-card` over the `surface-rail` rail column.
- **Split rail**: master-detail pages use a `240pt` rail (`192pt` below `860pt` wide), resizable between `180pt` and `360pt`, with the detail pane always keeping at least `400pt`. The rail surface uses `surface-rail` (`#F3F7FA`), the headers stay borderless aligned with the detail header, and the split divider is a `1pt` hairline.

## 5. Layout Principles

- **Spatial grid**: `4pt` base unit, `8pt` preferred step. Gaps cluster at `4`, `8`, `12`, `16`, `20pt`; card padding is `24pt`; page padding is `32pt`.
- **Window**: default `1040 x 720pt`, minimum `720 x 520pt`, title bar `42pt` tall with hidden native chrome.
- **Frame**: the title bar and sidebar draw one band with no separator. The work panel fills the remaining area, takes `12pt` on its start-start corner only, and clips its content so the band shows through the curve. No border between band and panel.
- **Page column**: one shared container, `max-w-5xl` (`1024pt`) wide, centered, `32pt` padding, `32pt` vertical gap between sections. A page never sets its own width, padding, or scrolling, so a destination switch moves nothing.
- **Split pages**: master-detail destinations fill the panel edge to edge, with a fixed `56pt` header bar in each pane and their titles on one spine.
- **Responsive behavior**: `860pt` is the single content breakpoint; below it, two-column field rows stack and the rail narrows. The layout stays one column from `720pt` up; nothing is hidden.
- **Density**: rows are `32-56pt` tall, controls `32-36pt`. Prefer density over whitespace; this is a utility that shows lists and forms, not a marketing page.

## 6. Design System Notes for Stitch Generation

- **Atmosphere keywords**: cool slate desktop utility, tactile elevated paper cards, crisp 4-point rhythm, cool hairline structure (`#DDE4ED`), soft slate card shadows, ice-slate master column (`#F3F7FA`), slate-900 primary buttons (`#0F172B`), one signal blue accent.
- **Canonical colors**: Paper White `#ffffff`, Slate Column `#F3F7FA`, Slate Control `#F9FBFD`, Slate Ink `#0F172B`, Slate Muted `#5A697E`, Slate Hairline `#DDE4ED`, Slate-900 Primary `#0F172B`, Signal Blue `#2563EB`, Signal Blue Soft `#E6F1FF`, Emerald Success `#079669`, Warning `#D08700`, Destructive `#E7000B`, Cool Slate Chrome `#E6ECF4`.
- **Prompt: settings page**: a centered `1024pt` column with `32pt` padding, a `24pt` bold page title, then elevated `16pt`-radius cards with cool slate hairline borders, soft card shadows, and `24pt` padding. Each card holds a `16pt` semibold section heading, then full-row switches with the label left and a `40pt` track right, separated by hairline dividers.
- **Prompt: master-detail list**: a resizable `240pt` cool ice-slate (`#F3F7FA`) left rail with a `56pt` borderless header holding a title, count pill, and primary `+` icon button, and a scrollable list of `12pt`-radius rows where the selected item lifts onto a pure white bordered card with a soft shadow. The right pane is a `56pt` borderless header with a badged provider icon, record name, and `启用 [Switch]`, then `16pt`-radius shadowed cards for connection fields (`12pt`-radius inputs/selects) and a `12pt`-radius table with a light slate header.
- **Prompt: translate panel**: an empty state with a `30pt` bold headline and a muted hint, an input row of `36pt` height with `12pt` radius, and a muted footer row of `12pt` metadata with icon buttons of `32pt`. Cool slate neutral palette, one blue brand-ghost action.

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

### Quick Translate Back-translation

Recorded before editing the Quick Translate TSX. Every entry reuses an existing token from `components/motion.ts`; the change adds no decorative motion.

| State change                                                              | Tool and reduced motion                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Back-translate icon toggle (`brand-ghost`) and embedded card header icons | Existing `Button` (`icon-xs`, `brand-ghost` / `ghost`) with `motion.pressScale` (0.95 active scale, 150ms easeOut), `selected` `brand-soft` wash + instant `muted-foreground` <-> `brand` icon swap on `mdi:arrow-u-left-top`, `focus-visible:ring-2`, and `buildTooltip` (`motion.tooltip`). Reduced motion removes transitions, tooltip fade, and press scale. |
| Embedded back-translation card opens, shows loading or error, or closes   | Immediate insertion or removal inside the forward card body inside the existing `Scroll` region, with no enter, exit, or layout animation. Loading text swaps immediately to the completed `TranslationOutput` or inline error. Reduced motion makes no change.                                                                                                  |
| Embedded card copy icon and label change                                  | Instant swap between `mdi:content-copy` and `mdi:check` (`success` tone) with no glyph animation.                                                                                                                                                                                                                                                                |
| Embedded card speak icon and label change during loading and playback     | Instant swap between `mdi:volume-high`, `mdi:close-circle`, and `mdi:stop-circle-outline`, keeping button size and header alignment fixed.                                                                                                                                                                                                                       |
| Drag or keyboard reorder, continuous or ambient animation, sound          | Reorder uses existing `CARD_REORDER_SETTLE_MS` on the card container. No continuous animation or sound.                                                                                                                                                                                                                                                          |

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
| Primary add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `DetectionChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                         |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation                                | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`). Reduced motion removes toast movement.                                                             |

### Text-to-speech channels

Recorded before editing the Text-to-Speech settings TSX to match the Language Detection and OCR channel picker. Every entry reuses an existing token from `components/motion.ts` or native row drag timing; the change adds no decorative motion.

| State change                                                        | Tool and reduced motion                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List and detail entrance                                            | Existing `motion.pageEnter` (`opacity: [0, 1]`, 200ms easeOut). Instant with reduced motion.                                                                                    |
| Primary add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `TtsChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                               |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation, sample playback               | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`); the existing preview phase and playback controls. Reduced motion removes toast movement.           |

### OCR channels

Recorded before editing the OCR settings TSX to match the Language Detection channel picker. Every entry reuses an existing token from `components/motion.ts` or native row drag timing; the change adds no decorative motion.

| State change                                                        | Tool and reduced motion                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List and detail entrance                                            | Existing `motion.pageEnter` (`opacity: [0, 1]`, 200ms easeOut). Instant with reduced motion.                                                                                    |
| Primary add button, row press, remove button, chevron, picker cards | Existing `motion.pressScale` (0.95 active scale, 150ms easeOut) and `motion.navigationFeedback` (color wash, 150ms easeOut). Reduced motion removes scale and transitions.      |
| Add channel dialog and remove confirmation dialog                   | Existing `AppDialog` with `motion.dialogAnimation` (`"fade"`). Instant with reduced motion; focus moves into the dialog on open and returns to the trigger or new row on close. |
| Channel added or removed in list                                    | Immediate insertion or removal in `OcrChannelList` without extra row entrance animation; focus moves to the added control or next logical target.                               |
| Enable switch and drag reorder (2+ channels)                        | Existing `motion.switchThumb` (150ms easeOut) and `REORDER_SETTLE_MS` (180ms easeOut) pan settle. Reduced motion sets values immediately.                                       |
| Detail validation, save confirmation                                | Inline error and save toast (`motion.toastTransition`, `motion.toastStack`). Reduced motion removes toast movement.                                                             |

### Google Cloud Vision OCR

Recorded before editing the OCR settings TSX to add the Google Cloud Vision channel. The row, detail, switch, and reorder reuse the OCR channel inventory above. This change adds no motion. Field text and validation errors stay instant, including with reduced motion.

### Channel connection test

Recorded before editing the channel editor header. Every entry reuses an existing token or the shared tooltip.

| State change                                                      | Tool and reduced motion                                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection result appears or clears beside the Connection heading | Instant swap. The existing success or error toast still carries `motion.toastTransition` and `motion.toastStack`. Reduced motion does not change the swap. |
| A truncated status badge is hovered                               | The shared `buildTooltip` bubble and its `motion.tooltip` transition. Instant with reduced motion.                                                         |
| Test button label switches between Test connection and Testing…   | Instant label and disabled-state swap; the button keeps `motion.pressScale`. Reduced motion removes the press scale.                                       |

### Cool Slate Theme & Elevated Card Styling

Recorded before editing `theme.json`, `nsh.json`, `components/ui/*`, and the workspace screens. Every entry reuses existing motion tokens in `components/motion.ts`.

| State change                                                              | Tool and reduced motion                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar destination, rail row, button, select, or input hover/focus/press | Existing `motion.navigationFeedback` (150ms easeOut color/wash) and `motion.pressScale` (0.95 active scale, 150ms easeOut). Reduced motion removes transitions/scale. |
| Rail selection changes (channels, presets, settings sections)             | Instant surface swap onto `bg-card` with `shadow-card` (`dark:shadow-card-dark`) and `border-border` over `bg-surface-rail`. Reduced motion keeps the swap.           |
| Inline and row switches toggle                                            | Existing `motion.switchThumb` (150ms easeOut thumb translation) and `motion.navigationFeedback` track color transition. Reduced motion makes the change instant.      |
| Card, table row, or dialog reveal                                         | Elevated cards rest statically with `shadow-card`; dialogs keep `motion.dialogAnimation` (`"fade"`); popups keep `motion.popup`. Reduced motion removes fade/slide.   |
