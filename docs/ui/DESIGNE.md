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
| Models, Presets, or Settings enters | Native opacity motion on the inner content container (`pageEnter`, 200 ms, ease-out) while the outer `PageSurface` `bg-background` fill stays opaque. No directional slide between sibling pages. | Instant |
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

- **Resizable master-detail split**: `SplitPane` (`components/layout/split-pane.tsx`,
  built on `components/ui/resizable.tsx` wrapping `nsh/base`'s
  `ResizablePanelGroup` and `ResizablePanel`) separates the left rail and right
  detail pane with a draggable vertical divider. The left panel uses `fixed`
  sizing (`240` pt default, `192` pt default below `860` pt when uncustomized,
  minimum `180` pt, maximum `360` pt, clamped so the detail pane keeps at least
  `400` pt), while the right pane fills the remaining space. Window resizes keep
  a customized rail width while clamping it to the current viewport. Each split
  workspace persists its own rail width in `Storage` (`split.models.railWidth`,
  `split.presets.railWidth`).
- **Unified borderless split header band**: Both the left `ChannelsRail` header and right
  `ProviderEditor` header use a fixed `h-14` borderless bar (no `border-b`) so
  their titles align across the vertical `SplitPane` divider without a crosshair
  line. The right header aligns to the same `mx-auto w-full max-w-4xl` spine as
  the cards below (`px-6` on desktop, `px-4` below `860` points), promotes the
  channel title to `text-lg font-semibold` (with `size-5` provider mark) above
  card `SectionHeading`s (`text-base font-semibold`), and renders conflict and
  unsupported-configuration alerts as inset `rounded-lg` banners.
  Neither pane uses a persistent bottom footer bar, eliminating mismatched bottom
  hairlines and oversized disabled commit buttons.
- **Master rail**: A `Channels` header and `+` icon trigger over a full-height
  scrollable channel list (`px-2 pb-2`, without a duplicate `border-r`, since the split handle
  draws the `bg-border` hairline). Each channel row keeps a fixed leading status lane
  (`check-circle` when enabled, muted `minus` when disabled, paired with text and
  accessible state) plus a two-line display name and a provider mark + name
  subtitle (`OpenAI`, `Google Gemini`, `Anthropic`, `DeepSeek`, or `Custom`).
  Selection highlights the row surface (`border-border bg-accent`), and reorder
  arrows appear only on the selected row when multiple channels exist, keeping
  the status column fixed.
- **Detail pane**: Displays the selected channel's `h-14` header (title, inline
  rename, enabled `Switch`, hairline divider, and quiet destructive-hover delete
  trigger), followed by scrollable `Connection` and `Models` cards
  (`rounded-xl border border-border bg-card`, `p-5` on normal and `p-4` on narrow
  viewports, scroll container `px-6 pb-6 pt-2` and `px-4 pb-4 pt-1` compact). The saved editor is keyed by channel ID. A channel switch disposes
  the old editor and its native controls. Updates to the same channel keep the
  editor and its pending connection edits.
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
- **Reusable controls**: UI primitives (`Avatar`, `Button`, `Input`, `Checkbox`, `Select`,
  `Switch`, `Badge`, `Card`, `Dialog`, `Icon`, `ToastProvider`) live under
  `components/ui/`. Copy stays bare: helper text appears only where scope,
  security consequence (`http://` confirmation), or error recovery needs it.

### Provider picker and channel draft

- **Provider picker**: `AddChannelDialog` presents the five provider presets
  (`OpenAI`, `Google Gemini`, `Anthropic`, `DeepSeek`, `Custom`) as a responsive
  two-column button card grid (`Button` with `size="card"`, leading circular
  `Avatar` wrapping `nsh/base`'s `Avatar` with the preset `Icon` fallback and
  preset name) inside `AppDialog`. No connection fields or descriptive subtitles
  appear in the picker. On open, focus moves to the first preset card;
  dismissing without choosing restores focus to the trigger (`+` or empty-state
  `Add Channel`).
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

### Module-owned provider settings

- **Controlled boundary**: `ProviderEditor` owns every connection value. It
  mounts the selected provider's registered `Settings` component through
  `ProviderSettingsHost` with the current protocol, URL, credential draft,
  saved-credential presence and edit mode (`keep`, `replace`, `clear`),
  URL/insecure-HTTP state, and compact/disabled flags plus change callbacks. The
  contribution renders fields and reports edits; it keeps no second draft,
  reads no saved secret, and never touches Storage or the Store.
- **Ownership split**: `ConnectionFields` holds only the protocol selector (or
  its fixed value), `Base URL`, the insecure `http://` consent checkbox, and
  `API Key` with its keep/clear actions. The editor keeps the `Connection`
  header, `Test`, inline `Unsaved`, contextual `Cancel` / `Save`, request
  status, the draft identity card, and the models card. Field test IDs, labels,
  placeholders, credential masking, and fixed-versus-selectable API behavior are
  unchanged.
- **Provider marks**: Presentations contribute the existing monochrome SVGs.
  `ProviderMark` renders them with the same `foreground` tint and decorative
  accessibility behavior inside `Avatar`'s fallback slot (picker), the rail
  subtitle, the editor header, and the draft identity card. The global
  `IconName` union no longer needs provider brands.
- **Unchanged interaction and motion inventory**: Adding a provider requires no
  page or editor branch. Focus entry into the draft `Display Name`, focus
  return after picker/discard dismissal, same-channel edit retention,
  channel-switch disposal, keyboard names, and reduced-motion behavior stay as
  recorded below. No new transition is added for provider switching; the
  existing hover, press, popup, dialog, and avatar transitions remain the only
  motion.

### Editor controller and unsupported records

- **Controller ownership**: `ChannelEditor` calls
  `createChannelEditorController(props)` once per owner. The controller owns
  current form values, request fingerprints, abort controllers, connection
  snapshots, saves, revision conflicts, partial-save reporting, and model
  actions; it returns accessors and actions, never module-global signals. The
  view holds only the JSX. `ModelsPage` keeps the channel-ID `Each` key, the one
  draft, discard confirmation, focus restoration, and leave guards, so a channel
  switch disposes the old editor and same-channel revisions do not remount it.
- **Unsupported stored modules**: A stored provider, channel-default protocol, or
  model override this build lacks stays visible. The common shell keeps the
  channel name, a neutral mark, the models card, and `Delete Channel`; a
  localized `role="alert"` banner states that the configuration is unavailable.
  Missing Settings are not mounted and unknown records are never converted to
  Custom or deleted. A known provider shows a selector for an unsupported
  default even when it is normally fixed, and model dialogs include an
  unsupported stored override so it can be replaced. `Test` and `Get models`
  stay disabled until the channel default is usable; an unknown model override
  blocks only that model's save. Discovery-source metadata is harmless.
- **Preserved lifetimes**: Request fingerprints still drop stale responses,
  channel switching still aborts in-flight work, and first-save, saved
  connection, and saved model write scopes plus `PartialDraftSaveError` recovery
  are unchanged.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Split handle hover, drag, and thumb grip | Native color transition (`navigationFeedback`, 150 ms, ease-out: `bg-border` -> `group-hover:bg-ring` -> `group-active:bg-primary`) and thumb opacity transition (`tooltip`, 150 ms, ease-out); panel split tracks the pointer 1:1 per frame natively | Instant color/opacity; 1:1 pointer tracking unchanged |
| Button, preset card, and trigger hover/press | Native color & transform transition; `navigationFeedback` + `pressScale`, 150 ms, ease-out | Instant color, no scale |
| Channel row and model row hover/selection | Native background & border transition (`navigationFeedback`, 150 ms, ease-out) without press scale | Instant |
| Switch and Checkbox state | Native track/box transition (`navigationFeedback`) + thumb slide (`switchThumb`, 150 ms, ease-out) | Instant |
| Select popup, Tooltip, Provider picker, and Discard confirmation | Native popup/tooltip transitions (`popup`, `tooltip`, 150 ms) and dialog fade (`dialogAnimation` / `aboutDialog`) | Instant |
| Avatar icon fallback and image load | Provider picker preset icons render statically inside `Avatar` fallback (no transition); `Avatar` image loads use native opacity transition (`avatarImage`, 150 ms, ease-out) | Instant |
| Saved channel changes | Replace the detail editor immediately, with no cross-fade: connection fields must show only the selected channel. Keep the existing rail selection feedback. | Instant |
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
- **Provider picker Avatar validation**: Verified `components/ui/avatar.tsx` (wrapping `nsh/base`'s `Avatar`) in `AddChannelDialog` via `mise run verify` (78/78 headless tests passed), `nsh test features/models/channels.test.tsx --target windows` (36/36 Windows desktop tests passed), and Windows desktop PNG screenshots in Light (`zh-CN`, rest & hover at `1040 × 720` and compact `720 × 520`) and Dark (`en`, rest & hover at `1040 × 720`). Confirmed circular `rounded-full` `bg-muted` clipping, centered `foreground`-tinted SVG marks, contrast in both themes, decorative `accessibilityLabel=""` (0 labeled `role:image` nodes, 5 accessible preset buttons), and hover washes. Held press state, remote `src` image loading fade, and screen-reader speech remain unverified in this pass.

- **Editor controller and unsupported records**: `ai workspace:` cases (unknown
  provider stays visible with deletion and zero requests; an unknown default
  protocol is corrected and restores the fixed display; an unknown model override
  keeps records and blocks only that save; an unknown discovery source never
  blocks) passed with the four named channel-switch/stale-response regressions,
  the full `features/models` suites, `ai settings:`, `ai registry:`, and
  `ai setup:`. `mise run check` and `mise run build` passed with no missing
  export.
- **Module-owned settings extraction**: `ai registry:` presentation cases
  (registration, duplicates, missing runtime provider), `ai setup:` (one ordered
  built-in set after two initializer calls), and `ai settings:` (a distinct
  registered component renders; edits stay with the host) passed.
  `provider channels:`, `features/models/models.test.tsx`, and `App.test.tsx`
  stayed green through the extraction, and `mise run build` emitted 25 assets
  with no unknown-class or missing-export warning.

### Module migration validation

- `mise run verify` passed formatting, lint, type checks, the Rust crate,
  the full headless test set, and the release bundle after the old
  `services/protocols/` path was deleted; `git grep` found no
  `services/protocols` import in `App.tsx`, `app`, `features`, `components`,
  or `modules`, and no runtime/protocol import of AI UI, presentations, or
  features, and no contract import of implementations or NSH.
- Contribution review: adding a provider now needs a definition, a presentation,
  locale entries for any new copy, and explicit `app/ai-setup.ts` registration.
  No union, existing protocol implementation, page branch, catalog-provider map,
  or global brand enum changes; the `ai registry:` / `ai settings:` tests are the
  extension evidence.
- Preserved behavior: `provider routing:` assertions now run through the real
  client and registered built-ins; `provider channels:` (45), `models` (7),
  `storage` (6), `App` (16), `ai client:` (20), `ai protocol:` (10),
  `ai settings:` (2), `ai setup:` (1), and `ai registry:` (11) cases passed.
- Windows desktop runs passed `channels.test.tsx` (45), `models.test.tsx` (7),
  and `provider-settings.test.tsx` (2). Captured and reviewed screenshots of:
  the provider picker (light `1040 × 720`), an Anthropic draft with its fixed
  API type (light `1040 × 720`), an OpenAI saved channel with a dirty URL and
  the API selector open (light `1040 × 720`), an unknown-provider channel with
  the unsupported-configuration banner (dark `720 × 520`, reduced motion), and
  an unsupported model-override save error in `EditModelDialog` (light
  `1040 × 720`). Radius, typography, spacing, alignment, color, hover styling,
  masked credentials, and the existing motion inventory are unchanged; no new
  transition was added for provider switching.
- Outstanding: screen-reader speech (Windows Narrator), held-press states, and
  frame-by-frame motion timing were not verified in this automated session.
  The extraction adds no new controls, copy, or motion, so these remain the
  pre-existing manual checks.

### Channel-switch validation

- `mise run verify` passed: formatting, lint, type checks, 94 headless tests,
  and the release bundle. Windows runs passed all 41 channel tests, 7 model
  tests, and 2 temporary visual checks.
- Windows screenshots in light and dark, at `1040 × 720` and `720 × 520`,
  show one URL value and one credential placeholder after repeated switches
  with unsaved inputs. Radius, typography, spacing, alignment, and color stay
  consistent with the existing controls. The dark checks use reduced motion.
- Selection and the immediate detail swap passed. Connection fields, model
  rows, search reset, credential read-only state, and same-channel edit retention
  passed. Hover and pressed styles are unchanged; held presses, frame-by-frame
  motion, and screen-reader speech were not checked in this pass.

## Presets workspace

Presets manages AI translation presets using the same split master-detail structure, semantic tokens, bare copy, and shared controls as Models (`PageSurface` with `layout="split"` and `testID="presets-page"`). Models remains the startup destination; **Presets** sits directly below **Models** in the top sidebar group (`nav-presets`), reusing `assets/icons/file-text.svg` with the standard `sidebar-foreground` / `sidebar-accent-foreground` tint and `sidebar-foreground/10` selected wash, while **Settings** remains at the bottom.

### Split layout and responsive structure

- **Unified borderless split header band**: Both the left `PresetsRail` (`SplitPane` rail, `240` pt default or `192` pt compact default under `860` points, persisted under `split.presets.railWidth`) and the right `PresetEditor` (`min-w-0 flex-1`) share a fixed `h-14` borderless header bar aligned across the draggable `bg-border` divider.
- **Master rail (`PresetsRail`)**: Displays the `Presets` heading and `+` icon button (`add-preset-button`, disabled while loading, unreadable, or mutating). Below the header, saved presets render in a virtualized NSH `List` keyed by preset ID (`keyExtractor`, `px-2 pb-2`), showing each preset's truncated name, `Enabled`/`Disabled` `Badge`, and model summary (`Channel · Model`, plus fallback count when present). Unsaved new drafts render a pinned `preset-draft-item` preview row with an `Unsaved` warning badge above the list. Missing/unreadable storage renders an inline `role="alert"` load error with a **Retry** button (`presets-retry-button`) and keeps creation disabled.
- **Pinned header actions and scrollable editor**: The right pane aligns its `h-14` header to `mx-auto w-full max-w-4xl` (`px-6` on desktop, `px-4` below `860` points), displaying the live preset title (`text-lg font-semibold`), `Unsaved` badge when dirty or new, inline `Enabled` switch (`preset-enabled`), `Cancel` (`preset-cancel`), and `Save` (`preset-save`) so primary actions stay visible at `720 × 520` without header crowding or horizontal overflow. Below the header, one `<Scroll class="min-h-0 flex-1">` owns the centered reading column (`mx-auto w-full max-w-4xl`, `gap-5 px-6 pb-6 pt-2` on desktop and `gap-4 px-4 pb-4 pt-1` under `860` points), ending with `Delete Preset` (`preset-delete`, `destructive-outline`) for saved presets.
- **Editor sections**: Uses shared `Card`, `SectionHeading`, `FormField`, `Input`, `Textarea` (over `nsh/base` `Input` with `multiline` and `submitBehavior="newline"`), `Select`, `Switch`, `Badge`, `Button`, and `ConfirmDialog`:
  - Top identity card: `Name` input (`preset-name`).
  - **Languages**: `Source language` (`auto` or concrete LangNext ID) and `Target language` (`No preference` or concrete LangNext ID) paired horizontally on `>= 860` points and stacked vertically under `860` points, built dynamically from live `t()` lookups so language changes apply immediately.
  - **Models and parameters**: `Primary model` selector (`Channel · Model` choices), ordered fallback chain rows (`Select`, up/down move buttons with boundary disables, remove button) plus **Add fallback**, optional `Temperature` and `Max output tokens` pair (horizontal `>= 860`, stacked `< 860`), inline `warning` notices for unavailable bindings without exposing deleted raw IDs, and **Manage Models** (routed through the shared navigation leave guard) when unavailable bindings exist, no eligible models exist, or Models failed to load.
  - **Prompt templates**: Template selector list (`w-52` column at `>= 860`, stacked above editor at `< 860`) displaying a **Default** badge (`preset-template-default-badge`) on exactly one template, `+ Add template`, template `Name` field, **Set as default** and **Remove** (disabled on the current default), multiline `System prompt` and `User prompt` `Textarea`s keyed by active template ID (where Return inserts a newline), and the supported variable hint (`{{source_language}}`, `{{target_language}}`, `{{text}}`).

### Temperature input

Use the shared decimal `Input` with two stacked arrow buttons at its trailing edge. The editor range is fixed at `0.0–2.0` for all presets. Show the range only in the empty input as placeholder text. Each step is `0.1`. Disable the button that would go past an endpoint. Reject out-of-range edits and more than one decimal digit. Format committed values with one decimal digit. A blank input uses the model default. Increase starts an empty field at `0.0`. The provider notes below describe API limits, not editor rules.

- OpenAI [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create): 0 to 2 where the model supports the parameter. Some reasoning models omit it.
- [Anthropic Messages](https://platform.claude.com/docs/en/api/php/messages/create): 0 to 1 where supported. [Claude 4.7 and later and Mythos Preview](https://platform.claude.com/docs/en/build-with-claude/working-with-messages) do not support custom sampling. This project keeps API version `2023-06-01`; API version `2026-10-21` removes this parameter for every Claude model.
- [Gemini generateContent](https://ai.google.dev/api/generate-content#generationconfig): 0 to 2 where supported. The [model metadata](https://ai.google.dev/api/models#Model) can specify a lower maximum; the editor does not fetch it. The [newer Gemini models](https://ai.google.dev/gemini-api/docs/gemini-3) can ignore or reject the parameter.
- DeepSeek [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion.md), [Responses](https://api-docs.deepseek.com/guides/responses_api.md), and [Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api.md): 0 to 2. The temperature has no effect in thinking mode.

### Focus paths

- Opening a new preset draft focuses `preset-name` automatically (`autoFocus` / `InputRef.focus()`).
- On validation failure at Save, focus moves to the first invalid field; if the invalid field belongs to a non-selected prompt template, that template is selected first before focusing the field.
- Dirty-navigation confirmation (`ConfirmDialog`) focuses **Keep Editing** (`focusNode`: `node.focus()` + `setAccessibilityFocus(node)`) on open; choosing **Keep Editing** or pressing Escape retains all edits and restores focus to the last active editor input (falling back to `preset-name`), while **Discard** executes the pending action.
- Cancelling deletion restores focus to **Delete Preset**; confirming deletion waits for dialog dismissal (`onClose`) and focuses the next list row, the previous row if none follows, or the empty-state **Add Preset** button (`empty-add-preset-button`) when the list becomes empty.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Presets workspace enters | Native opacity motion on the inner content container (`pageEnter`, 200 ms, ease-out) while the outer `PageSurface` `bg-background` fill stays opaque | Instant |
| Split handle hover, drag, and thumb grip | Shared `SplitPane` handle transitions (`navigationFeedback` color, `tooltip` thumb opacity, 150 ms, ease-out); panel split tracks the pointer 1:1 per frame natively | Instant color/opacity; 1:1 pointer tracking unchanged |
| Sidebar item, rail row, template tab, and button hover/press | Native color & transform transition; `navigationFeedback` + `pressScale`, 150 ms, ease-out (rows/tabs omit press scale) | Instant color, no scale |
| Enabled switch state | Track transition `navigationFeedback`; thumb translation `switchThumb`, 150 ms, ease-out | Instant |
| Select popups and tooltips | Native popup/tooltip transitions (`popup`, `tooltip`, 150 ms, ease-out) | Instant opacity, no slide |
| Dirty leave and delete confirmation dialogs | Native dialog fade (`dialogAnimation`) | Native reduced-motion behavior |
| Saved preset / new draft editor swap | Keyed by preset ID or `__new__` (`Each`); replaces editor immediately with no cross-fade so scroll position and input state never leak across presets | Instant |
| Template selection, fallback reorder, Default badge, Saving label | Updates immediately to match state; no drag, continuous animation, or streaming | No change |
| Temperature step and input validation | The input value and endpoint button states update immediately. Arrow buttons use `pressScale` and the shared ghost hover and focus states. | Instant value change and color; no scale |

### Verification notes

- **Desktop Windows & visual audit**: Verified `App.test.tsx --filter "presets nav:"` and `features/presets/presets.test.tsx` in real desktop windows (`--target windows`), plus rendered Windows screenshot inspections across Light/Dark themes, `1040 × 720` and compact `720 × 520` (`reducedMotion: true`) viewports, `en` and `zh-CN` localizations, empty, multi-fallback, multiline prompt, unavailable/deleted model, validation-error, and discard confirmation states.
- **Temperature input**: Windows tests verified the arrow buttons, endpoint states, decimal format, and typed edit rejection. Headless tests verified paste rejection because the Windows driver cannot paste. Screenshots in Light (`en`, `1040 × 720`) and Dark (`zh-CN`, `720 × 520`, reduced motion) show the placeholder inside the input, arrow alignment, disabled state, and the filled value. The dark screenshot shows the hover wash after a click. Held press and Narrator were not verified.
- **Test-driver & accessibility notes**: In headless `nsh test`, `app.keyboard.press` dispatches keys to `onKeyCommand`, menus, focused `<Input>` controls, and `Escape` rather than non-input `<Button>` focus activation (`Space`/`Enter`), so button focus transitions are verified via native `ViewRef.focus()` + `setAccessibilityFocus()` calls on `onClose` alongside direct activation; live Windows Narrator UIA screen-reader announcement remains unverified manually outside automated accessibility labels and `role="alert"`/`role="alertdialog"` semantics.

### Resizable split validation

- **Checks**: `mise run verify` passed formatting, lint, type checks, all 171 headless tests (including `components/layout/split-rail.test.ts` and the new drag-resize/persistence tests in `models.test.tsx` and `presets.test.tsx`), and the release bundle. Real Windows desktop runs (`--target windows`) passed `features/models/models.test.tsx` (8/8) and `features/presets/presets.test.tsx` (11/11).
- **Visual audit & Finishing checklist**: Inspected Windows desktop PNG screenshots across Light (`1040 × 720`, rest & widened + divider hovered) and Dark (`720 × 520`, `reducedMotion: true`, clamped from widened storage) for both Models and Presets:
  - *Radius, typography, spacing, alignment*: `h-12 border-b` header hairlines align across the `1` pt vertical divider; no duplicate `border-r`; widened rails eliminate premature channel-name truncation and clamped `268` pt compact rails preserve `400` pt editor width without header clipping.
  - *Color, hover, states, motion*: Rest hairline uses `bg-border`; hovering highlights `bg-ring` and fades in the centered `rounded-full` `bg-muted-foreground` grip thumb; `active:` uses `bg-primary` and per-frame 1:1 native dragging (`ResizablePanelGroup`); `reducedMotion` disables transition durations while keeping live drag tracking.
  - *Accessibility & outstanding*: Both handles expose localized `handleAccessibilityLabel` strings via `t()` (`models.channels.resizeLabel`, `presets.list.resizeLabel`) over `nsh/base`'s `adjustable` handle role. Held drag-press color (`active:`) and live Windows Narrator keyboard adjustment remain manual desktop checks.

## Settings workspace

Settings uses the same `PageSurface` (`layout="split"`) and `SplitPane` master-detail structure as Models and Presets (`testID="settings-page"`), with its own persisted rail width (`split.settings.railWidth`).

- **Left category rail (`settings-rail`)**: Shares the borderless `h-14` header (`Settings`) aligned across the draggable `bg-border` divider, followed by selectable category rows (`px-2 pb-2`; `General` selected by default on launch, `Appearance`) styled with `Button` (`size="row"`) and `border-border bg-accent` selection fill. The active category stays in session state when navigating to other sidebar destinations and back.
- **Right detail pane (`settings-detail`)**: Displays the active category title (`text-lg font-semibold`) inside an aligned `mx-auto h-14 w-full max-w-4xl` borderless header (`px-6` on desktop, `px-4` below `860` points) above a `<Scroll>` column (`mx-auto w-full max-w-4xl`, `gap-5 px-6 pb-6 pt-2` on desktop and `gap-4 px-4 pb-4 pt-1` under `860` points):
  - **General**: Hosts the **Language** `Card` (`System`, `English`, `简体中文` `RadioGroup` and inline save-error `role="alert"`).
  - **Appearance**: Hosts the **Theme** `Card` (`Light`, `Dark`, `System` `RadioGroup` and inline save-error `role="alert"`) and the **Transparent title bar and sidebar** `Switch` `Card`.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Settings workspace enters | Native opacity motion on the inner content container (`pageEnter`, 200 ms, ease-out) while `PageSurface` `bg-background` stays opaque | Instant |
| Split handle hover, drag, and thumb grip | Shared `SplitPane` handle transitions (`navigationFeedback` color, `tooltip` thumb opacity, 150 ms, ease-out); panel split tracks the pointer 1:1 per frame natively | Instant color/opacity; 1:1 pointer tracking unchanged |
| Category row & radio option hover/selection | Native color & border transition (`navigationFeedback`, 150 ms, ease-out) without press scale | Instant |
| Category switch (`General` <-> `Appearance`) | Immediate detail pane replacement (`If`) with no cross-fade so scroll position resets per section | Instant |
| Transparency switch & save error | Existing `navigationFeedback` + `switchThumb` (`150 ms`, ease-out); no animation on save error | Instant switch; no change on error |

### Validation

- **Checks**: `mise run verify` passed formatting, lint, type checks, all headless tests (including updated `App.test.tsx`, `components/layout/split-rail.test.ts`, and `features/settings/settings.test.tsx`), and the release bundle. Real Windows desktop runs (`--target windows`) passed `features/models/models.test.tsx` (8/8), `features/presets/presets.test.tsx` (11/11), and `features/settings/settings.test.tsx` (3/3).
- **Visual audit & Finishing checklist**: Inspected Windows desktop PNG screenshots across Light (`1040 × 720`, `zh-CN` across Models, Presets, and Settings General/Appearance; plus `en` Settings with hovered split handle) and Dark (`720 × 520`, `en` and `zh-CN`, `reducedMotion: true`, across Models, Presets, and Settings General/Appearance):
  - *Radius, typography, spacing, alignment*: Borderless `h-14` header bands align left and right titles across the `1` pt vertical divider without a crosshair hairline; right detail headers (`text-lg font-semibold`) align to `max-w-4xl` card edges below, clearly leading card `SectionHeading`s (`text-base font-semibold`), while concentric `rounded-xl` cards and `rounded-lg` radio/switch rows fit cleanly without clipping at `720 × 520`.
  - *Color, hover, states, motion*: Category selection (`border-border bg-accent`), radio selection (`checked:border-primary checked:bg-accent`), transparency switch, and hovered split handle (`bg-ring` + centered pill thumb) render cleanly in light and dark.
  - *Accessibility & outstanding*: Category navigation carries `role="navigation"` + `accessibilityLabel`, radio groups carry `accessibilityLabel`, and the split handle carries `settings.resizeLabel`. Held press (`active:`), frame-by-frame motion timing, and live Windows Narrator speech remain manual checks.

## Quick Translate popup

Quick Translate runs inside a separate floating NSH window (`id="quick-translate"`) rather than an in-window modal so the popup stays lightweight and available even when the main window is hidden.

- **Compact geometry & chrome**: Opens at `420 × 360` points (`minSize: 340 × 280`, non-auto-growing fixed initial footprint) near the active cursor on Windows (or centered fallback) with `kind="panel"`, `level="floating"`, `taskbar={false}`, `minimizable={false}`, `maximizable={false}`, and `titleBar={{ style: "hidden", height: 38 }}` so the platform renders the native window frame and close caption button while a compact custom header (`desktop={{ windowDrag: true }}`) places window title, Auto-translate toggle, **Pin**, and Close beside `titleBar().right`.
- **Colors & copy**: Uses semantic surface/text/border tokens only (`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `text-destructive`, `text-success`, `border-border`, `ring-ring`); no hard-coded presentation hex/RGB colors. Copy stays bare and localized via `t()`.
- **Scroll & focus ownership**: One vertical `<Scroll>` container inside the popup body owns scrolling across the shared language/source controls and ordered preset result cards. Source `<Textarea>` takes focus when opened or re-focused; opening any `<Select>` or **Add preset** `<Menu>` overlay stays inside the popup window tree without blurring it, and `Escape` dismisses open overlays before closing the window (`closeOnEscape={!hasOpenOverlay()}`). Unpinned blur closes the window and resets pin on every close path without quitting the app.
- **Preferences & privacy boundaries**: Quick Translate restores only explicit user preferences (`quickTranslate.preferences.v1`: `doubleCopyEnabled`, `autoTranslate`, `sourceLanguage`, `targetLanguage`, and ordered `{ id, presetId, templateId, collapsed }` cards after `presetsStore` finishes loading, dropping missing/disabled presets and deleted template overrides). Draft text, translation outputs, pin state, errors, keystroke history, and API credentials are never persisted there; shortcut registration conflicts warn cleanly without blocking startup and fall back to the tray menu.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Quick Translate window show, focus, and close | Native `<Window>` show/focus/hide lifecycle (`level="floating"`, `closeOnBlur={!pinned}`, `closeOnEscape={!hasOpenOverlay}`) | Immediate native show/close |
| Header Auto, Pin, Close, Add preset, Collapse, Retry, Copy, and Remove action buttons | Shared `navigationFeedback` (`150 ms`, ease-out colors) + `pressScale` (`active:scale-95`), focus-visible ring (`ring-ring`) | Instant color/ring, `scale-100` |
| Language, preset, and template Select overlays | Shared `Select` `Overlay` popup (`motion.popup`, `150 ms`, ease-out, `-translate-y-1` reveal inside the popup root so native blur does not fire) | Instant opacity, no slide |
| Add preset menu overlay | Shared `Menu` + `MenuItem` overlay (`motion.popup`, `motion.popupHidden`, `150 ms` ease-out inside the popup root so native blur does not fire) | Instant opacity, no slide |
| Ordered preset cards (add, remove, collapse/expand, independent status/result/copy) | Direct keyed list updates (`<Each key={(card) => card.id}>`) in the single `<Scroll>` container preserving card order across out-of-order completions; direct collapse/expand body toggle keeping stored results; `text-muted-foreground` loading status, `text-destructive` error text, and `check` / `text-success` copy feedback with no shimmer or continuous spin | Instant state swap and layout update |

- **Visual audit & Finishing checklist**: Inspected rendered Windows `--target windows` PNG screenshots covering the compact `420 × 360` floating popup (Light `en` multiline input), HTTP 429 error card with `Retry` (Light `en`), multi-card result (Dark `zh-CN`, `reducedMotion: true`), and Settings → General Windows double-copy card (Light `en` and Dark `zh-CN`). Fixed reactive `titleBar().right` clearance in `QuickTranslateWindowBody` so header Auto/Pin icons clear the native Win32 caption close button without overlap, and paired **Clear input** beside **Add preset** cleanly so single-card error/result cards fit inside the initial `360` pt frame without clipping. Verified semantic colors, card/input/button radii, typography contrast, spacing, overlay Escape handling, keyboard Enter/Shift+Enter/IME guards, and reduced-motion state updates; manual interactive desktop spot-checks remain noted for live external-app `Ctrl+Shift+T`, live multi-app double-`Ctrl+C` settlement, and interactive Narrator/DPI drag checks.

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
