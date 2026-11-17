# Design System

## Page layout

The title bar and sidebar share one glass surface. `nsh.json` enables the native `popover` backdrop
(Acrylic on Windows 11). With transparency enabled, the shell's root draws `bg-sidebar/70` once over that material.
With it disabled, the root draws opaque `bg-sidebar` and the window uses no backdrop. The title bar and sidebar
draw no background of their own, so their tints do not stack. Icons and text stay fully opaque. The native
material depends on the operating system. Leave `transparent` unset: NSH 0.5.1 treats a transparent Windows
window as frameless, which removes the existing system window buttons. A backdrop alone enables composition.

The work area keeps its opaque `bg-background` fill. Its start-start corner (top-left in a left-to-right layout)
is `rounded-2xl` and the panel clips its content, so the curve shows the glass surface behind it. Its other edges
stay flush with the window, where a radius would only cut into the frame. No border separates the work area
from the chrome. Layout, hit targets, and the existing motion inventory stay unchanged.

One container serves every sidebar destination: `PageSurface`
(`components/layout/page-surface.tsx`) owns the work area's scrolling and its
content column. The column is `class="mx-auto w-full max-w-4xl gap-8 p-8"`: it fills the window up to a
reading width and stays centred, so a wide window spends its surplus on the margins instead of stretching
every line to the window edge. A page renders only its sections and never sets its own width, padding,
scrolling or leading edge, so every destination shares one layout and switching between them moves nothing.

`class` carries static layout and appearance. `style` is for values computed at run time only: platform
metrics (`titleBar()` in the shell's title bar) and theme colors (`token()` in the sidebar). Static spacing,
sizes and colors belong in classes; a value with no class-scale step gets an arbitrary class
(`max-w-[824px]`), not a `style`.

## Sidebar navigation

The desktop shell opens Models by default. The sidebar groups destinations by
position: the Models button sits at the top, the Settings button at the
bottom. The shell owns the current page. Every button exposes its selected state.
Icon destinations draw their outline asset normally and their solid asset while
current, tinted by the item's foreground token. Native buttons provide keyboard
activation where NSH supports view focus. Each tooltip shows only the
destination name. NSH 0.5.1 declares view Tab focus for macOS and Web; do not
assume Windows has the same support.

Each item is styled by one token pair, `sidebar-accent` on `sidebar-accent-foreground`:
a lighter wash on hover, the full wash while pressed, and the same wash held for the
current destination. Those states belong to the button's own variants (`hover:`,
`active:`, `selected:`, `group-selected:`), never to a class picked in JavaScript:
an element keeps the class it was created with, so only a state variant restyles it
when `selected` changes.

Models is a title placeholder until the model list is built. It uses the
existing text scale, spacing, surfaces, and semantic theme colors.
`PageSurface` owns scrolling, the shared leading edge and the centred column;
each page supplies only its sections, which wrap at the minimum window width.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Navigation hover and press | Native color transition; `navigationFeedback`, 150 ms, ease-out; press deepens the fill | Instant |
| Current destination | Selected fill follows the current page with the same transition. No sliding marker: the two destinations sit at opposite ends of the sidebar. | Instant |
| Models or Settings enters | Native opacity motion; `pageEnter`, 200 ms, ease-out. No directional slide between sibling pages. | Instant |
| Navigation tooltip opens or closes | Native opacity transition; `navigationFeedback`, 150 ms, ease-out | Instant |
| Labels, user-controlled layout, gestures, loading, live content | None. Both pages show static content. | No change |

Motion tokens are defined in `components/motion.ts`. Settings controls retain
their existing behavior and appearance.

### Validation before glass

- Radius, typography, spacing, alignment, and theme colors: reviewed in Windows
  screenshots, in light and dark, at 1440 × 900, 1040 × 720 and 720 × 520. The
  content column stays centred at every width, keeps one leading edge on Models
  and Settings, and clips nothing at the minimum window.
- Shell chrome: reviewed in Windows screenshots at 1040 × 720 in light and dark. The
  title bar and sidebar draw one band with no separator, and the work area's rounded
  start-start corner shows that band through the curve. The corner is faint in light
  (`sidebar` is 0.985 against `background` 1) and clear in dark (0.205 against 0.145).
- Shared container: the same `PageSurface` renders both destinations, so a
  page cannot drift from the others in width, padding or scrolling.
- Hover and selection: reviewed both destinations and their tooltips.
  Selected controls keep a readable foreground during hover.
- Pressed state: uses a stronger fill. Pointer cancellation was not tested.
- Shared components and standards: both destinations use `SidebarItem`. Both
  pages use `PageSurface`. Existing Settings controls remain unchanged.
- Other states: selection and tooltip dismissal pass native tests. Models has no
  disabled controls, loading, error, or dynamic content.
- Motion: page entry, selection feedback, and tooltips run natively. Reduced-motion
  navigation passes tests. Frame-by-frame motion was not reviewed. No sound is used.
- Accessibility: role/name selectors pass Windows tests. Screen-reader behavior
  and Tab focus were not verified.
- Platforms and content: Windows only. Large text, other desktop platforms, and
  right-to-left layout remain manual checks. Mobile and TUI are outside scope.

### Glass validation

- Checks: `mise run verify` passed. All 11 headless tests and the final 11 Windows desktop tests passed.
  Two earlier desktop runs missed different navigation or menu actions. The baseline and final full run passed;
  the cause was not confirmed. Test code did not change.
- Native material: the built bundle ran in the Windows 11 host at 150% display scale. DWM reported Acrylic
  (backdrop type 3) with composition enabled. The native window buttons remained visible.
- Preview limit: the NSH 0.5.1 Windows hot-reload host reported Acrylic but had composition disabled.
  `mise run dev` therefore does not show the complete glass effect. Verify the built bundle instead:
  run `mise run build`, then `./target/debug/nsh-app-my-translator-windows-host.exe --bundle .nsh/out/bundle.nshc`
  after a desktop test has built that host. The native test host uses the same development path; its passing
  tests prove behavior, not the system material.
- Color and surfaces: light and dark screenshots were reviewed with the window focused over blue and red
  backgrounds. Chrome colors changed with the background; the work area's sampled RGB stayed at
  `255,255,255` in light and `10,10,10` in dark. An unfocused window used the system's solid material fallback.
- Radius, typography, spacing, and alignment: reviewed in light and dark. The shared band, work area's rounded
  corner, icon alignment, and content layout remained intact. No geometry or text styles changed.
- Hover and other states: sidebar hover, tooltip dismissal, selection, theme changes, and About passed desktop
  tests. Pressed styles did not change; held presses and pointer cancellation were not reviewed.
- Shared components and standards: no new controls or variants. The shell owns one tint; `PageSurface` still
  owns the opaque work area. All colors come from existing tokens.
- Motion and sound: no new motion or sound. Page changes, menu dismissal, About reopening, and reduced-motion
  navigation passed desktop tests. Frame-by-frame animation was not reviewed.
- Accessibility and platforms: role/name selectors and minimum-size navigation passed Windows tests.
  Full keyboard use, screen readers, larger text, other platforms, and right-to-left layout remain unverified.

## Transparency setting

Appearance contains a `Transparent title bar and sidebar` switch. It is on by default, which preserves the
existing appearance. The setting is stored as `settings.transparency` (`"true"` or `"false"`) and loaded before
mounting the shell. Missing or invalid values use the default. A save failure keeps the session's choice and
shows an error near the switch, as the theme setting does.

`features/settings/transparency.ts` owns the preference. `AppShell` owns the native window effect: it sets
`backdrop` to `popover` or `none` and uses `classList` to change the shared chrome fill. The work area stays opaque.
The launch backdrop in `nsh.json` remains set so a built Windows window allocates composition before it opens;
turning the setting off does not prevent turning it on again. No restart is required. The Windows development
preview limit described above still applies.

`components/ui/switch.tsx` styles NSH's native switch behavior. Its label is also its accessible name. The label
sits at the leading edge and the track at the trailing edge. Pressing either toggles the setting. Theme tokens
supply the row, track, thumb, hover, pressed, and focus colors. Existing page geometry stays unchanged.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Switch hover and press | Native color transition; `navigationFeedback`, 150 ms, ease-out; press deepens the row wash | Instant |
| Switch checked state | Track color transition; `navigationFeedback`. Thumb translation; `switchThumb`, 150 ms, ease-out | Instant |
| Chrome transparency | Native window backdrop changes immediately; the shared fill follows the preference | Instant |
| Save error appears | No animation; the message states that the choice is only saved for this session | No change |
| Pages, navigation, menus, dialogs | Existing inventories above; no changes | Existing behavior |
| Gestures, loading indicators, continuous content, sound | None for this setting | No change |

### Validation

- Checks: `mise run verify` passed, including all 14 headless tests. All 14 Windows desktop tests passed.
  New tests cover switching, saved choices, reopening, theme and page changes, invalid values, minimum size,
  and reduced motion.
- Native effect: the built bundle switched DWM's backdrop from Acrylic (3) to none (1) and back in the same
  window. Composition remained enabled. Closing with transparency off, reopening, and enabling it again passed.
- Color and surfaces: over a blue background, light chrome changed from RGB `222,231,249` on to `250,250,250`
  off. Dark chrome changed from `34,48,74` on to `23,23,23` off. The content area stayed `255,255,255` in light
  and `10,10,10` in dark. Window buttons remained visible.
- Radius, typography, spacing, and alignment: light and dark screenshots were reviewed at the default and
  minimum window sizes. The label, track, thumb, and card fit without clipping. Existing token and scale classes
  supply their colors and geometry.
- Hover and pressed: the full row's hover wash was reviewed. Presses on the row toggled the setting in native
  tests and in the built app. Pressed styles are defined; held presses and pointer cancellation were not reviewed.
- Shared controls and states: the reusable switch owns its row and part styles. Checked and unchecked thumb
  positions were reviewed in both themes. Role/name selectors passed. Storage failure messages were not forced.
- Motion and sound: switch positions, track changes, page navigation, overlays, and reduced-motion switching
  passed native checks. Animation timing was not measured frame by frame. No new sound or continuous motion.
- Accessibility and platforms: Windows only. The framework's Windows Tab-focus limit remains; full keyboard use,
  screen readers, larger text, right-to-left layout, and other platforms were not verified.

## Language and localization

Every string the user reads comes from `t()` in `nsh/i18n`. Translations live in `locales/en.yml` and
`locales/zh-CN.yml`; the build carries them, and a key a language lacks falls back to English.

`features/settings/language.ts` owns the preference: `system` follows the user's own language, `en` and
`zh-CN` override it. It is stored as `settings.language` and loaded before mounting the shell; a missing or
invalid value follows the system. A save failure keeps the session's choice and shows an error near the
control, as the appearance setting does.

Settings shows Language as a second card with its own radio group, using the same card and choice styles as
Appearance. Each language name stays in its own language (`English`, `简体中文`), so a reader who cannot read
the current interface language still finds theirs. The tray menu is rebuilt when the language changes, so its
Exit item follows the app. Messages already on screen keep the text they were created with; later actions use
the new language.

### Validation

- Checks: `mise run verify` passed, including all 26 headless tests. Two tests cover the system language and a
  chosen language that survives a reopen.
- Coverage: the Models workspace, its dialogs, Settings, the sidebar, the app menu, and About render without a
  missing-key marker in Chinese at 1040 × 720. English keeps every existing test assertion.
- Not verified: Chinese screenshots in light and dark, desktop windows, longer text in other languages, screen
  readers, and right-to-left layout.

## App menu and About

The title bar uses `assets/logos/icon.svg` as a compact menu button. The rest of
its surface still drags the window. A `w-13` lane centers the button on the
sidebar's icon axis. The lane starts after `titleBar().left` to clear system
window controls. The menu contains one action, `About`.
`AppMenu` owns the menu and dialog state. It opens the dialog after the menu's
exit completes, so the two surfaces do not overlap.

The centered About dialog shows the app logo, name, and version from `appInfo()`.
It does not show an unverified release date or copyright. Its footer has one
`OK` button. Escape and a backdrop press also close it. Native `Menu` and `Dialog`
components own keyboard navigation, dismissal, and focus. Controls have accessible
names and visible focus styles. Windows view focus still needs platform checks.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Menu trigger, About item, and OK hover or press | Native color transition; `navigationFeedback`, 150 ms, ease-out; press deepens the fill | Instant |
| Menu opens or closes | Native popup transition; `popup`, 150 ms, ease-out; opacity and a 4-point slide from the trigger | Instant |
| About opens or closes | Native dialog `fade` animation; `aboutDialog` | Native reduced-motion behavior |
| Glyphs, labels, selection, layout, gestures, loading, live content | None. About shows static build metadata. | No change |

The popup and dialog use theme surfaces, foregrounds, and borders. `overlay`
is a black scrim at 40% opacity in both themes. Sizes, text, spacing, and radii
use the existing utility scales. The monochrome logo takes the surface's foreground
tint so that it stays visible in dark mode. Windows desktop is the validation
target; mobile and TUI are outside this change.

### Validation

- Radius, typography, spacing, alignment, and color: reviewed in Windows screenshots
  in light at 1040 × 720 and dark at 720 × 520. No clipping found. The logo now
  uses a theme tint; the black source was not legible in dark mode.
- Hover and pressed: state classes use the existing feedback tokens. Pointer
  activation passes. The settled menu was checked after hover; held presses and
  pointer cancellation were not reviewed.
- Shared components and standards: `AppMenu` contains styled native controls.
  The shell only composes it. Menu-open state stays visible on the trigger.
- Other states: accessible role/name selectors, menu cancellation, OK, Escape,
  and reopening pass headless and Windows tests. Backdrop dismissal is configured
  natively but not verified: the test press targets the covered backdrop center.
- Motion and sound: menu-to-dialog sequencing and native dialog entry were checked
  in Windows. Reduced-motion behavior passes tests. No sound is used. Frame-by-frame
  motion was not reviewed.
- Accessibility and keyboard: Windows Tab + Enter did not open the menu. NSH 0.5.1
  declares view focus for macOS and Web only. Full keyboard completion and focus
  restoration remain blocked by that platform limitation. Narrator was not tested.
- Platforms and content: Windows only. Larger text, right-to-left layout, and other
  platforms remain manual checks. About has no loading, error, or editable state.

## App icon and tray

The taskbar, the window, and Explorer draw the app icon from `nsh.json` `icon`:
`assets/logos/icon.png`, the rounded tile from `assets/logos/icon-rounded.svg`
rendered at 1024 px. That key takes a raster, not an SVG: the tool reads it with
its image decoder. The tile is part of the icon, not a background: the mark is
black, and a transparent icon would disappear on a dark taskbar.

The tray draws `assets/logos/icon.svg`, the mark without the tile. NSH paints
an SVG tray icon through its alpha in the taskbar's or menu bar's text colour, so
the rounded tile would collapse into a solid square; the bare mark stays readable
in light and dark. Its menu holds one item, `Exit`; a primary press brings the
main window back.

## Models workspace

Models adapts the master-detail structure to My Translator's tokens, bare copy,
and native controls. `PageSurface` provides `layout="split"` alongside `"column"`
so Settings stays unchanged while Models fills the work area edge-to-edge without
nesting scroll views.

### Channels rail and detail pane

- **Unified split header spine**: Both the left `ChannelsRail` header and right
  `ProviderEditor` header use a fixed `h-12` bar with `border-b border-border` so
  the horizontal hairline aligns to the pixel across the vertical split divider.
  Neither pane uses a persistent bottom footer bar, eliminating mismatched bottom
  hairlines and oversized disabled commit buttons.
- **Master rail**: A `w-60` (`w-48` under `860` points) `border-r border-border`
  column with a `Channels` header and `+` icon trigger, followed by a full-height
  scrollable channel list. Each channel row keeps a fixed leading status lane
  (`check-circle` when enabled, muted `minus` when disabled, paired with text and
  accessible state) plus a two-line display name and a provider mark + name
  subtitle (`OpenAI`, `Google Gemini`, `Anthropic`, `DeepSeek`, or `Custom`).
  Selection highlights the row surface (`border-border bg-accent`), and reorder
  arrows appear only on the selected row when multiple channels exist, keeping
  the status column fixed.
- **Detail pane**: Displays the selected channel's `h-12` header (title, inline
  rename, enabled `Switch`, hairline divider, and quiet destructive-hover delete
  trigger), followed by scrollable `Connection` and `Models` cards
  (`rounded-xl border border-border bg-card`, `p-5` on normal and `p-4` on narrow
  viewports).
- **Connection card**: Groups `API Type` and `Base URL` on one row on desktop
  (`>= 860` points) and `API Key` below, placing `Test`, inline `Unsaved` badge,
  and contextual `Cancel` / `Save` actions directly in the `Connection` header so
  the save scope matches the form without shifting the `Models` card below.
- **Models card**: Pairs `Models` title, item count, and sync timestamp tightly in
  the header beside a labeled `Protocol` sync selector and `Get models`, followed
  by the search/filter/`Add Model`/`Select` toolbar and either a borderless empty
  state or the models `Table` (with `Select` hidden when empty).
- **Dialogs and overlays**: `AddChannelDialog`, `AddModelDialog`,
  `EditModelDialog`, and `ConfirmDialog` share `AboutDialog`'s `rounded-2xl
  border border-border bg-background` frame, padded header/body, and `bg-muted`
  footer bar over `bg-overlay`. Non-blocking status notices appear in a top-level
  `ToastStack` anchored at `bottom-4` centered inside an `inset-x-0 bottom-4
  pointer-events-none` `Overlay` (with `pointer-events-auto` preserved on each
  toast's Dismiss button).
- **Reusable controls**: UI primitives (`Button`, `Input`, `Checkbox`, `Select`,
  `Switch`, `Badge`, `Card`, `Dialog`, `Icon`, `ToastProvider`) live under
  `components/ui/`. Copy stays bare: helper text appears only where scope,
  security consequence (`http://` confirmation), or error recovery needs it.

### Provider picker and channel draft

- **Provider picker**: `AddChannelDialog` presents the five provider presets
  (`OpenAI`, `Google Gemini`, `Anthropic`, `DeepSeek`, `Custom`) as a responsive
  two-column button card grid (`Button` with `size` scaled to the grid cell,
  centered or leading provider `Icon` and preset name) inside `AppDialog`. No
  connection fields or descriptive subtitles appear in the picker. On open, focus
  moves to the first preset card; dismissing without choosing restores focus to
  the trigger (`+` or empty-state `Add Channel`).
- **Right-pane draft**: Selecting a preset closes the picker and mounts the
  draft in `ProviderEditor`, keeping the `h-12` split header spine aligned with
  `ChannelsRail`. The draft header holds the preset mark, live channel name,
  `Unsaved` indicator, `Enabled` switch, and channel-scoped `Cancel` / `Save`
  actions. A top identity card aligns the read-only `Provider` mark/label and
  editable `Display Name` input on the same two-column spine as `Default API
  type` and `Base URL` below (`< 860` points stacks to one column). Focus moves
  into the draft's `Display Name` field on entry.
- **Provider marks (`assets/icons/`)**: `openai.svg`, `gemini.svg`,
  `anthropic.svg`, and `deepseek.svg` are monochrome SVGs sourced from
  `@lobehub/icons-static-svg@1.103.0` (`https://github.com/lobehub/lobe-icons`,
  MIT License); brand marks remain trademarks of their respective owners for
  provider identification only. `Custom` reuses `cube-outline.svg`.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Button, preset card, and trigger hover/press | Native color & transform transition; `navigationFeedback` + `pressScale`, 150 ms, ease-out | Instant color, no scale |
| Channel row and model row hover/selection | Native background & border transition (`navigationFeedback`, 150 ms, ease-out) without press scale | Instant |
| Switch and Checkbox state | Native track/box transition (`navigationFeedback`) + thumb slide (`switchThumb`, 150 ms, ease-out) | Instant |
| Select popup, Tooltip, Provider picker, and Discard confirmation | Native popup/tooltip transitions (`popup`, `tooltip`, 150 ms) and dialog fade (`dialogAnimation` / `aboutDialog`) | Instant |
| Draft entry and leave/discard transitions | Picker closes via `dialogAnimation` and immediately reveals right-pane draft with focus on `Display Name`; discard confirmation opens via `dialogAnimation` and keeps or clears draft immediately on decision | Instant |
| Toast notifications | Native `ToastStack` / `Toast` slide & fade (`toast` motion tokens, auto-hide 3.5 s, swipe-to-dismiss) | Instant fade/no slide |
| Connection dirty actions, remote test/sync, model list updates, search/filter updates | `Cancel` / `Save` and model row updates apply immediately; spinner/status labels swap immediately (`Test…` / `Fetching…` / `Saving…`) | No change |

### Validation

- **Checks**: Automated unit/logic/storage checks (`logic.test.ts`, `storage.test.ts`), headless UI suites (`channels.test.tsx`, `models.test.tsx`), Windows desktop UI suites (`nsh test features/models/channels.test.tsx --target windows`, `nsh test features/models/models.test.tsx --target windows`), clippy/oxlint, format check, and release bundle check verified after final UI edits. (`App.test.tsx` leaves `"settings.language"` unset and follows the host OS locale, so under a Simplified Chinese Windows locale 15/16 shell label assertions read `"设置"`/`"外观"`/`"模型"` rather than English.)
- **Screenshots and layout**: Visually inspected Windows desktop PNG screenshots across Light and Dark themes, English and Simplified Chinese (`zh-CN`), default (`1040 × 720`, rendered `1560 × 1080` at 1.5x scaling) and minimum compact (`720 × 520` via `app.setViewport`, rendered `1080 × 823` with `reducedMotion: true`) viewports covering:
  - `AddChannelDialog` provider picker grid (empty and compact windows),
  - Right-pane drafts for selectable-API (`OpenAI`, `DeepSeek`), fixed-API (`Google Gemini`), non-loopback `http://` warning checkbox state, sync error inline + toast (`HTTP 503`), and synced model rows,
  - `Discard Draft` (`ConfirmDialog`) in `en` and `zh-CN`, and `AddModelDialog` / `EditModelDialog` in compact `720 × 520`.
- **Adjustments made from visual and hit-test review**: Widened the Channels rail to `w-56` on normal desktop widths (`w-48` under `860` points) and scoped reorder arrows to the selected channel row so names avoid early truncation; tightened `< 860` card/editor padding (`p-4`) and folded `API Type` into the model subtitle at narrow widths so `Get models` and model rows wrap and fit cleanly at `720 × 520`; updated `ToastViewport` (`components/ui/toast.tsx`) to `inset-x-0 bottom-4 items-center pointer-events-none` on `Overlay` and `pointer-events-none` on `ToastStack`/`Toast` with `pointer-events-auto` on the Dismiss button so bottom-centered toasts never block clicks on underlying navigation or table checkboxes on Windows.
- **Keyboard, reduced motion, and accessibility**: Verified on Windows (`--target windows`) that `<Input>` auto-focus moves cleanly into draft `Display Name` and dialog primary fields, `Return` submits dialog inputs, `Escape` dismisses `AddModelDialog` and `EditModelDialog` even while inputs hold focus, focus restores to triggers after dialog dismissal (with `ViewRef.focus()` `Tab`/Space button activation noted by NSH 0.5.1 as `(macOS, the web)`), and `reducedMotion: true` passes functionally without blocking dialog/toast state transitions. All interactive buttons, icon triggers, switches, checkboxes, and dialogs expose localized `accessibilityLabel` strings via `t()`. Frame-by-frame motion timing and interactive Windows Narrator screen-reader speech remain manual verification items in an interactive Windows desktop session (`UIAutomationClient` inspection against the non-interactive CLI session's detached `nsh dev` host exposed no interactive desktop UIA subtree from the automation context).

## Theme Colors
```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --success: oklch(0.527 0.154 150.069);
  --success-foreground: oklch(0.985 0 0);
  --warning: oklch(0.681 0.162 75.834);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --success: oklch(0.696 0.17 162.48);
  --success-foreground: oklch(0.145 0 0);
  --warning: oklch(0.769 0.188 70.08);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}
```
