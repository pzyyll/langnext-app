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
main window back. Closing the main window stays in the background: its close
button, Alt+F4, the taskbar and the window menu hide it, the app keeps running
behind the tray icon, and only `Exit` quits.

`nsh.json` `window.defaultVisible: false` makes the platform open the main
window hidden, so no window exists to flash before the app decides. `AppShell`
reads `settings.silentLaunch` once after the first pass: a normal launch shows the
window, and a silent one leaves it hidden, unseen and unfocused, with the tray
icon, the global shortcuts, and the tray menu as the way in. The switch only
changes the next launch. A later launch of the app and a press on the tray icon
both bring the window back.

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
- **Master rail (`PresetsRail`)**: Displays the `Presets` heading and `+` icon button (`add-preset-button`, disabled while loading, unreadable, or mutating). Below the header, saved presets render in a virtualized NSH `List` keyed by preset ID (`keyExtractor`, `px-2 pb-2`), showing each preset's truncated name, `Enabled`/`Disabled` `Badge`, and model summary (`Channel · Model`, plus fallback count when present). Unsaved new drafts render a pinned `preset-draft-item` preview row with an `Unsaved` warning badge above the list. An unreadable storage envelope shows an inline `role="alert"` load error with a **Retry** button (`presets-retry-button`) and keeps creation disabled. If only individual entries cannot be read, the rail shows a muted notice (`presets-skipped-notice`) below its header. A trailing close button hides this notice across app restarts. The list and Add Preset remain usable. Dismissal does not change stored presets.
- **Pinned header actions and scrollable editor**: The right pane aligns its `h-14` header to `mx-auto w-full max-w-4xl` (`px-6` on desktop, `px-4` below `860` points), displaying the live preset title (`text-lg font-semibold`), `Unsaved` badge when dirty or new, inline `Enabled` switch (`preset-enabled`), `Cancel` (`preset-cancel`), and `Save` (`preset-save`) so primary actions stay visible at `720 × 520` without header crowding or horizontal overflow. Below the header, one `<Scroll class="min-h-0 flex-1">` owns the centered reading column (`mx-auto w-full max-w-4xl`, `gap-5 px-6 pb-6 pt-2` on desktop and `gap-4 px-4 pb-4 pt-1` under `860` points), ending with `Delete Preset` (`preset-delete`, `destructive-outline`) for saved presets.
- **Editor sections**: Uses shared `Card`, `SectionHeading`, `FormField`, `Input`, `Textarea` (over `nsh/base` `Input` with `multiline` and `submitBehavior="newline"`), `Select`, `Switch`, `Badge`, `Button`, and `ConfirmDialog`:
  - Top identity card: `Name` input (`preset-name`).
  - **Add Preset picker**: Both Add Preset buttons open `AddPresetDialog` (`add-preset-dialog`), a two-card `AppDialog` with `AI Translation` (`preset-type-ai`) and `DeepL API` (`preset-type-deepl`). The picker opens before any draft exists, focuses its first option, and dismisses with Escape, the backdrop, or Cancel back to the trigger. Selecting a type closes the picker first, then runs the existing dirty-draft discard guard; keeping edits leaves the current draft intact, and a proceeding creation focuses `preset-name`.
  - Presets carry engine configuration only. Source and target languages belong to the translation entry point: Quick Translate stores its own pair and resolves it once per action through Language Detection. The editor shows no language controls, so switching, adding, or removing presets never changes what the popup translates.
  - **DeepL editor**: A DeepL preset shows the name card and enabled switch plus one masked `API key` input (`preset-deepl-api-key`) and Delete. It never shows models, generation parameters, or prompt templates. A saved preset keeps its key out of the record and shows a stored-key placeholder instead of the value; typing a replacement marks the draft dirty. A missing key at Save shows the localized field error and focuses the input. The key is stored separately in local NSH Storage under a non-secret reference; it never appears in preset JSON, logs, or errors, and saving never contacts DeepL.
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
| Skipped presets notice | Appears with the loaded list or empty state. The shared ghost button uses `navigationFeedback` and `pressScale`; dismissal removes the notice immediately and moves focus to Add Preset when available. | Instant color and layout; no scale |
| Add Preset type picker | Shared `AppDialog` fade (`dialogAnimation`); the AI and DeepL card buttons use `navigationFeedback` + `pressScale`. Choosing a type closes the picker before any dirty-discard prompt, and a fresh draft's name input takes focus. | Native reduced-motion dialog behavior; instant color, no scale |

### Verification notes

- **Desktop Windows & visual audit**: Verified `App.test.tsx --filter "presets nav:"` and `features/presets/presets.test.tsx` in real desktop windows (`--target windows`), plus rendered Windows screenshot inspections across Light/Dark themes, `1040 × 720` and compact `720 × 520` (`reducedMotion: true`) viewports, `en` and `zh-CN` localizations, empty, multi-fallback, multiline prompt, unavailable/deleted model, validation-error, and discard confirmation states.
- **Temperature input**: Windows tests verified the arrow buttons, endpoint states, decimal format, and typed edit rejection. Headless tests verified paste rejection because the Windows driver cannot paste. Screenshots in Light (`en`, `1040 × 720`) and Dark (`zh-CN`, `720 × 520`, reduced motion) show the placeholder inside the input, arrow alignment, disabled state, and the filled value. The dark screenshot shows the hover wash after a click. Held press and Narrator were not verified.
- **Test-driver & accessibility notes**: In headless `nsh test`, `app.keyboard.press` dispatches keys to `onKeyCommand`, menus, focused `<Input>` controls, and `Escape` rather than non-input `<Button>` focus activation (`Space`/`Enter`), so button focus transitions are verified via native `ViewRef.focus()` + `setAccessibilityFocus()` calls on `onClose` alongside direct activation; live Windows Narrator UIA screen-reader announcement remains unverified manually outside automated accessibility labels and `role="alert"`/`role="alertdialog"` semantics.
- **DeepL presets checks**: `mise run verify` passed formatting, lint, type checks, all 332 headless tests, and the release bundle. The Windows development host passed the full `features/presets/presets.test.tsx` (16/16, including the Add Preset picker, the DeepL editor, and a `720 × 520` dark `zh-CN` reduced-motion pass), `features/quick-translate/popup.test.tsx --filter "quick languages:"` (1/1), and `--filter "DeepL card:"` (5/5), covering the shared detector run for AI and DeepL cards, automatic targets, explicit pairs, blocked detection with no DeepL fallback, and a DeepL-only action without AI models. Real desktop inspection of picker trigger-focus restore, live Windows Narrator announcements, and Light/Dark PNG screenshots at `1040 × 720` and `720 × 520` in both locales remains a manual check: this environment has no screenshot capture.

### Resizable split validation

- **Checks**: `mise run verify` passed formatting, lint, type checks, all 171 headless tests (including `components/layout/split-rail.test.ts` and the new drag-resize/persistence tests in `models.test.tsx` and `presets.test.tsx`), and the release bundle. Real Windows desktop runs (`--target windows`) passed `features/models/models.test.tsx` (8/8) and `features/presets/presets.test.tsx` (11/11).
- **Visual audit & Finishing checklist**: Inspected Windows desktop PNG screenshots across Light (`1040 × 720`, rest & widened + divider hovered) and Dark (`720 × 520`, `reducedMotion: true`, clamped from widened storage) for both Models and Presets:
  - *Radius, typography, spacing, alignment*: `h-12 border-b` header hairlines align across the `1` pt vertical divider; no duplicate `border-r`; widened rails eliminate premature channel-name truncation and clamped `268` pt compact rails preserve `400` pt editor width without header clipping.
  - *Color, hover, states, motion*: Rest hairline uses `bg-border`; hovering highlights `bg-ring` and fades in the centered `rounded-full` `bg-muted-foreground` grip thumb; `active:` uses `bg-primary` and per-frame 1:1 native dragging (`ResizablePanelGroup`); `reducedMotion` disables transition durations while keeping live drag tracking.
  - *Accessibility & outstanding*: Both handles expose localized `handleAccessibilityLabel` strings via `t()` (`models.channels.resizeLabel`, `presets.list.resizeLabel`) over `nsh/base`'s `adjustable` handle role. Held drag-press color (`active:`) and live Windows Narrator keyboard adjustment remain manual desktop checks.

## Settings workspace

Settings uses the same `PageSurface` (`layout="split"`) and `SplitPane` master-detail structure as Models and Presets (`testID="settings-page"`), with its own persisted rail width (`split.settings.railWidth`).

- **Left category rail (`settings-rail`)**: Shares the borderless `h-14` header (`Settings`, `px-4`) aligned across the draggable `bg-border` divider, followed by two labelled groups of selectable category items (`gap-5 px-2 pb-4 pt-1`; group container `gap-1.5` with `min-w-0 truncate px-2 text-xs font-medium text-muted-foreground` header, items list `gap-0.5`): **Application** holds `General` (selected by default on launch), `Appearance`, and `Shortcuts`; **Integrations** holds `Language Detection`, `OCR`, and `Text-to-Speech`, the categories that connect the app to a service. Items use `Button` (`variant="nav"`, `size="nav"`, `min-h-8 rounded-lg px-2 py-1.5`, borderless `selected:bg-accent` fill, `hover:bg-accent/60`, `active:bg-accent`, `text-foreground/80` rest -> `group-hover:text-foreground` -> `group-selected:font-medium group-selected:text-accent-foreground`) so the rail header, group headers, and category labels share one `16` pt leading spine. The active category stays in session state when navigating to other sidebar destinations and back.
- **Right detail pane (`settings-detail`)**: Displays the active category title (`text-lg font-semibold`) inside an aligned `mx-auto h-14 w-full max-w-4xl` borderless header (`px-6` on desktop, `px-4` below `860` points) above a `<Scroll>` column (`mx-auto w-full max-w-4xl`, `gap-5 px-6 pb-6 pt-2` on desktop and `gap-4 px-4 pb-4 pt-1` under `860` points):
  - **General**: Hosts the **Language** `Card` (`System`, `English`, `简体中文` `RadioGroup` and inline save-error `role="alert"`) and the **Silent launch** `Switch` `Card` (`settings-silent-launch-switch`) with its inline save-error `role="alert"`.
  - **Appearance**: Hosts the **Theme** `Card` (`Light`, `Dark`, `System` `RadioGroup` and inline save-error `role="alert"`) and the **Transparent title bar and sidebar** `Switch` `Card`.
  - **Shortcuts**: Windows shows cards in the app's standard settings style. **Open Quick Translate** (`Alt+Shift+D`), **Screenshot Translate** (`Alt+Shift+S`), and **Translate Selection** (`Alt+D`) share one card, with a divider between the editable rows. Each row uses the same recording, clear, reset, and alert states. Each shows a shortcut badge, or **Unassigned** after removal. The edit icon changes to a focused **Press a shortcut** control with **Cancel**. A valid, available chord saves immediately. The actions cannot share a binding: an earlier row keeps the chord, and the later row shows the inactive alert. Escape or leaving the row cancels recording. Clear removes the binding. Reset appears only when the value differs from the default, including when it is unassigned. An inline alert shows invalid input, a key conflict, or a storage failure. A failed update keeps the previous binding. **Translate Selection** first reads the selection through Windows UI Automation. The **Simulate Copy to Get Text** switch sits below its shortcut row, separated by a divider. It is off by default. When enabled, a control without selection-reading support can use its copy command; the switch label's tooltip says that this can replace the clipboard. A save failure keeps the confirmed setting and shows an inline alert. The action does not use OCR or add popup motion: a delivered selection uses the existing collapsed preview. `Alt+D` can still belong to the Edge or File Explorer address bar. Clear the row, or record another combination, to return that key. Reset tries `Alt+D` again and keeps the confirmed value when registration fails. The **Double-copy Quick Translate** card keeps its existing switch, whose label's tooltip explains what it does with copied text. Other platforms show a Windows-only notice and do not show these rows.
  - **Language Detection**: Hosts one `Card` (`settings-detection-card`) with a **Detection** `Select` (`Off`, `AI`, `Google`), the AI-only detection model chain (`Primary model` `Select`, ordered **Backup models** rows with add, move-up/down, and remove `Button`s), the **Native language** and **Translate my native language into** `Select`s, an inline `role="alert"` for validation or write failures, and a trailing **Save** `Button`. Each language label carries its part of the Automatic-target mapping as a tooltip, so the form shows no help line. The `Off` and `Google` modes hide the model controls without discarding the draft's model IDs. An empty, failed, or unavailable model catalog keeps saved IDs visible with their reason and links to Models through the existing sidebar navigation. The section keeps a local draft; leaving the category discards it and the service only reads saved settings.
  - **OCR**: Uses a two-level list and detail structure backed by `settings.ocr.v3`. Level 1 (`settings-ocr-card`) lists all OCR channels (`AI OCR`, `Baidu OCR`) in persisted priority order (`channelOrder()`, default AI first, Baidu second) separated by `h-px bg-border` hairlines. The execution-order explanation (enabled channels run from top to bottom, later ones act as backups) sits in an info icon (`icon-park-outline--info.svg`, `settings-ocr-priority-info`) beside the `OCR` title in the detail header, shown as a hover tooltip (`settings.ocr.priorityHint`) and exposed to screen readers as the icon's accessibility label; the icon hides with the title when Level 2 swaps in the breadcrumb. Each row keeps the clickable channel summary (`Avatar` mark, channel title, dynamic `Primary` / `Backup` `Badge` when enabled, and live configuration or warning summary) as a sibling to `Move up` / `Move down` icon buttons (`settings-ocr-move-up-{kind}`, `settings-ocr-move-down-{kind}`), an inline `Switch` (`settings-ocr-toggle-{kind}`), and a trailing `chevron-right` configure button (`settings-ocr-open-{kind}`). Unconfigured channels disable their toggle with a tooltip (`settings.ocr.configureBeforeEnable`). Reordering or toggling persists immediately and shows `settings-ocr-list-error` (`role="alert"`) on write failure. Clicking a row or trailing chevron enters Level 2 (`settings-ocr-detail-card`) and switches the `SettingsPage` detail header to a `Breadcrumb` (`OCR > Channel Name`, `settings-ocr-breadcrumb`) whose root link (`settings-ocr-breadcrumb-root`) or rail item (`settings-nav-ocr`) returns to the list and restores focus to that channel row. The detail card is keyed by channel ID so leaving disposes local state and clears plaintext Baidu key drafts. Saving a previously unconfigured channel enables it automatically; saving an already-configured channel keeps its enabled state and shows a success toast (`settings.ocr.saved`). The AI detail branch shows image-capable enabled models (`settings-ocr-model`), unavailable-model warning (`settings-ocr-model-unavailable`), and empty/failed catalog recovery (`settings-ocr-models-recovery`, `settings-ocr-manage-models`); the Baidu branch keeps **Mode** (`settings-ocr-baidu-operation`, default `Accurate with Location`), masked **API Key** / **Secret Key** (`settings-ocr-baidu-api-key`, `settings-ocr-baidu-secret-key`), masked placeholder (`settings.ocr.savedKeys`) when readable, and `settings-ocr-baidu-keys-missing` (`role="alert"`) when unreadable. On systems other than Windows, the list shows `settings-ocr-windows-only` (`text-xs text-muted-foreground`).
  - **Text-to-Speech**: One Google Cloud channel in a list and detail structure backed by `settings.tts.v1`. The list (`settings-tts-card`) has one row: the color Google Cloud mark, the title `Google Cloud Text-to-Speech`, a summary (`Not configured`, `Configured`, or the unreadable-key recovery), an inline `Switch` (`settings-tts-toggle-google-cloud`), and a trailing chevron (`settings-tts-open-google-cloud`). There is no reorder control, priority badge, or fallback. An unconfigured channel disables the switch and shows `settings.tts.configureBeforeEnable`. The row or the chevron opens the detail card (`settings-tts-detail-card`). The header becomes the breadcrumb `Text-to-Speech > Google Cloud Text-to-Speech` (`settings-tts-breadcrumb`). The root (`settings-tts-breadcrumb-root`) or the rail item (`settings-nav-tts`) returns to the list, drops the draft, and restores focus to the row. The masked API key field (`settings-tts-api-key`) stays empty. A readable saved key shows the masked placeholder only. A line beside the field states that the key is stored on this device and is not encrypted. An empty draft does not save. The first successful save enables the channel. A later save keeps the current enabled state, clears the draft, and shows `settings.tts.saved`. A failed save keeps the draft and the previous channel. A missing key shows `settings-tts-key-missing` and still allows the switch to turn the channel off. Save and the switch do not call Google. An enabled switch means the channel is saved locally. **Play sample** (`settings-tts-preview`) sits beside Save. It sends the fixed English sample with the saved key, including when the channel is off, and does not use the draft. An unsaved key edit disables it until the edit is saved or cleared. While the sample loads the button is **Cancel**; while it plays the button is **Stop**. Leaving the detail aborts the request or stops playback. A failure stays beside the button. Playback uses a temporary MP3 under the app data directory and removes that file when the clip ends, stops, or the app launches again.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Settings workspace enters | Native opacity motion on the inner content container (`pageEnter`, 200 ms, ease-out) while `PageSurface` `bg-background` stays opaque | Instant |
| Split handle hover, drag, and thumb grip | Shared `SplitPane` handle transitions (`navigationFeedback` color, `tooltip` thumb opacity, 150 ms, ease-out); panel split tracks the pointer 1:1 per frame natively | Instant color/opacity; 1:1 pointer tracking unchanged |
| Category nav item & radio option hover/selection | Native color transition (`navigationFeedback`, 150 ms, ease-out) with borderless `bg-accent` selection fill on nav items (no press scale); radio options keep border + `bg-accent` selection | Instant |
| Category switch (`General`, `Appearance`, `Shortcuts`, `Language Detection`, `OCR`, `Text-to-Speech`) | Immediate detail pane replacement (`If`) with no cross-fade so scroll position resets per section | Instant |
| Language Detection mode `Off` <-> `AI` <-> `Google`, backup add/move/remove, and inline validation or save alerts | Immediate conditional and keyed list updates inside the shared `Card`; `Save` reuses `navigationFeedback`; no animation on row changes or alerts | Instant |
| Language Detection mode, model and preference `Select`s | Shared `Select` overlay (`motion.popup` / `motion.popupHidden`, `150 ms`, ease-out, `-translate-y-1` inside the popup root) | Instant opacity, no slide |
| OCR list and detail view entry | Native opacity motion (`createMotion({ enter: motion.pageEnter })`, 200 ms, ease-out) on the view container; header title / `Breadcrumb` swaps immediately | Instant |
| OCR channel row, breadcrumb root, reorder, chevron, and Save buttons | `navigationFeedback` (`150 ms`, ease-out) on row and breadcrumb buttons (no press scale); `pressScale` (`active:scale-95`, `150 ms`, ease-out) on icon and Save buttons | Instant color, `scale-100` |
| OCR list reorder (`↑`/`↓`), `Primary`/`Backup` badges, alerts, and `Select` popups | Channel order, `Primary`/`Backup` badges, and inline alerts update immediately; `Select` uses `motion.popup` / `motion.popupHidden` (`150 ms`, ease-out); save confirmation uses `ToastStack` (`toast` tokens) | Instant; no slide |
| OCR Baidu key fields | Shared masked `Input` focus ring (`focus-within:ring-ring`); no extra motion | Instant |
| Transparency, double-copy, simulated-copy, silent-launch, and OCR switches | Shared `navigationFeedback` + `switchThumb` (`150 ms`, ease-out); disabled-switch, OCR priority info, and icon-button tooltips use `motion.tooltip` (`150 ms`, ease-out opacity); inline alerts appear without animation | Instant switch, tooltip, and alerts |
| Text-to-Speech section selection and breadcrumb swap | Settings nav `navigationFeedback`; the header title and `Breadcrumb` swap immediately | Instant |
| Text-to-Speech list or detail enters | `createMotion({ enter: motion.pageEnter })` on the view container; the page background stays opaque | Instant |
| Text-to-Speech row, breadcrumb, chevron, Save, and Preview | `navigationFeedback` on the row and breadcrumb; `pressScale` on the chevron, Save, and Preview; the masked `Input` keeps `focus-within:ring-ring` | Instant color; no scale |
| Text-to-Speech enable switch | `navigationFeedback` and `switchThumb`; a disabled switch uses the existing tooltip | Instant |
| Text-to-Speech save confirmation | Shared `ToastStack` (`toast` tokens) | Instant; no slide |
| Text-to-Speech validation, saved-key summary, and Preview, Cancel, or Stop | Immediate text, glyph, and alert updates. No progress animation, overlay, gesture, or layout motion | No change |
| Shortcut recording, clear, reset, and alerts | Shared focus rings, `navigationFeedback`, and `pressScale`. The recorder, clear/reset availability, value, and inline alerts update immediately; no layout animation. | Instant feedback; no scale |

### Validation

- **Checks**: `mise run verify` passed formatting, lint, type checks, all headless tests (including updated `App.test.tsx`, `components/layout/split-rail.test.ts`, and `features/settings/settings.test.tsx`), and the release bundle. Real Windows desktop runs (`--target windows`) passed `features/models/models.test.tsx` (8/8), `features/presets/presets.test.tsx` (11/11), and `features/settings/settings.test.tsx` (3/3).
- **Visual audit & Finishing checklist**: Inspected Windows desktop PNG screenshots across Light (`1040 × 720`, `zh-CN` across Models, Presets, and Settings General/Appearance; plus `en` Settings with hovered split handle) and Dark (`720 × 520`, `en` and `zh-CN`, `reducedMotion: true`, across Models, Presets, and Settings General/Appearance):
  - *Radius, typography, spacing, alignment*: Borderless `h-14` header bands align left and right titles across the `1` pt vertical divider without a crosshair hairline; right detail headers (`text-lg font-semibold`) align to `max-w-4xl` card edges below, clearly leading card `SectionHeading`s (`text-base font-semibold`), while concentric `rounded-xl` cards and `rounded-lg` radio/switch rows fit cleanly without clipping at `720 × 520`.
  - *Color, hover, states, motion*: Category selection (`border-border bg-accent`), radio selection (`checked:border-primary checked:bg-accent`), transparency switch, and hovered split handle (`bg-ring` + centered pill thumb) render cleanly in light and dark.
  - *Accessibility & outstanding*: Category navigation carries `role="navigation"` + `accessibilityLabel`, radio groups carry `accessibilityLabel`, and the split handle carries `settings.resizeLabel`. Held press (`active:`), frame-by-frame motion timing, and live Windows Narrator speech remain manual checks.
- **Language Detection checks**: `mise run verify` passed formatting, lint, type checks, all headless tests (287/287), and the release bundle. The Windows development host passed `features/settings/settings.test.tsx --filter "language detection:"` (4/4), `features/presets/presets.test.tsx --filter "presets ui: no languages"` (1/1), and `features/quick-translate/popup.test.tsx --filter "language resolution:"` (6/6), covering the new category, the restored model order and language preferences, the unavailable-model and empty-catalog recovery states, inline validation, both locales, the Quick Translate language pair, and the shared popup detection run.
- **Pending visual audit**: `nsh test` offers no screenshot capture here, so the light and dark inspections at `1040 × 720` and `720 × 520` for the new section (radius, typography, spacing, alignment, token colors, hover/press/focus, empty and error states), keyboard reorder of the model chain, and Escape dismissal remain a manual desktop check for Mr. Julian. The compact layout itself is covered by the existing reduced-motion test and the shared `compact` branch below `860` points.
- **OCR settings checks**: Headless `features/ocr/settings.test.ts` (21/21), `features/ocr/recognize.test.ts` (17/17), `features/settings/settings.test.tsx --filter "ocr settings:"` (9/9), and `app/quick-translate.test.tsx --filter "quick ocr:"` (14/14) cover prioritized `settings.ocr.v3` persistence, unconfigured switch disable + tooltip, auto-enable on first save, preserving disabled state on edits, list reorder and toggle persistence, multi-channel fallback across Baidu and AI, unavailable model recovery, unreadable Baidu keys, failed writes, and both locales. Windows desktop runs (`--target windows`) passed the 5 non-mocked `ocr settings:` tests and the 12 Windows-applicable `quick ocr:` tests. Inspected 5 rendered Windows desktop PNG screenshots across Light (`1040 × 720`, `en`, hovered list row and `OCR > AI OCR` / `OCR > Baidu OCR` breadcrumb detail pages) and Dark (`720 × 520`, `zh-CN`, `reducedMotion: true`, list and detail pages):
  - *Radius, typography, spacing, alignment*: Verified concentric `rounded-xl` cards, `rounded-lg` full-row hit containers / inputs / selects / buttons, `rounded-md` icon buttons / badges / breadcrumb root, and `rounded-full` avatars / switch tracks; verified `Breadcrumb` root `OCR` aligns on the exact `24` pt (`16` pt compact) leading spine of the list header and card border below, and `720 × 520` compact rows fit `Primary` / `Backup` badges and trailing controls without wrapping or clipping.
  - *Color, hover, states, motion, accessibility*: Verified Light/Dark token contrast on `AI OCR` and monochrome `Baidu OCR` avatars (`token("foreground")`), full-row `hover:bg-accent/60` wash across the row width, `Primary` / `Backup` role badges, masked saved-key placeholders, and reduced-motion list/detail rendering. Held press (`active:`), frame-by-frame motion timing, and live Windows Narrator speech remain manual desktop checks.
- **OCR priority tooltip**: `mise run verify` passed formatting, lint, type checks, 455 headless tests (8 skipped), and the release bundle. Headless `features/settings/settings.test.tsx --filter "ocr settings:"` passed 9/9, and the Windows development host (`--target windows`) passed the same 5 non-mocked cases; the other 4 need headless-only viewport and module simulation. Inspected rendered Windows PNG screenshots across Light (`en` and `zh-CN`, `1040 × 720`) and Dark (`zh-CN`, `720 × 520`, `reducedMotion: true`): the `info` icon centers on the `OCR` title's optical baseline, the hover tooltip aligns its leading edge to the icon and wraps the note to two lines in both locales, the list ends with its last channel row, and the icon leaves with the title when the `OCR > Channel name` breadcrumb detail opens. Held frame timing and live Narrator speech remain manual checks.
- **Settings rail spacing & nav refinement**: `mise run verify` passed formatting, lint, type checks, all 390 headless tests (with 2 ignored desktop-overlay Rust tests), and the release bundle (`0` unknown-class warnings). Windows desktop runs (`--target windows`) passed `settings ui:` (`3/3`), `language detection:` (`5/5`), and non-mocked `ocr settings:` (`2/2`) in `features/settings/settings.test.tsx`. Visually audited 5 Windows desktop PNG screenshots across Light (`1040 × 720`, `zh-CN` rest & hovered `Appearance`, plus `en` rest) and Dark (`720 × 520`, `zh-CN`, `reducedMotion: true`, `General` & `Language Detection` selected): verified `rounded-lg` non-capsule nav pills, 3-tier rail typography, tighter group-heading (`6` pt) and sibling-item (`2` pt) gaps relative to inter-group spacing (`20` pt), one continuous `16` pt leading text spine across rail header/group headers/nav items, clear `bg-accent` vs `bg-accent/60` hover distinction in Light and Dark without borders, and clean non-clipping fit at `720 × 520`. Held press (`active:`), frame-by-frame motion timing, and live Windows Narrator speech remain manual checks.

- **Shortcuts checks**: `mise run verify` passed (421 passed, 2 skipped). The Windows desktop test saved a replacement with the native hotkey service. Headless tests covered activation, restart, and keeping the old shortcut on failure. Windows screenshots at `1040 × 720` (light, `en`) and `720 × 520` (dark, `zh-CN`, reduced motion) confirmed radius, typography, spacing, alignment, theme colors, hover, input focus, disabled Save, switch states, and validation text. The desktop test confirmed Enter to save. Held press, frame timing, full keyboard navigation, and live Narrator were not checked.

- **Shortcut recording checks**: The Windows test confirmed Enter to start, Esc and Tab to cancel, rejection of `Ctrl+C`, capture without a storage write, and Tab then Enter to save. Light (`en`, `1040 × 720`) and dark (`zh-CN`, `720 × 520`, reduced motion) screenshots confirmed shared radii, typography, spacing, alignment, token colors, hover, focus, recording, disabled Save, and error states. Held press, exact frame timing, and live Narrator were not checked. `mise run verify` passed on retry (422 passed, 2 skipped) after an existing channel test timed out once and passed in isolation.

- **Shortcut card checks**: `mise run verify` passed (422 passed, 2 skipped). Windows desktop tests covered recording and automatic save, Esc, Cancel, Tab, and clearing the binding. Headless tests covered persistence, reset visibility, and failed updates. Light (`en`, `1040 × 720`) and dark (`zh-CN`, `720 × 520`, reduced motion) screenshots confirmed the existing card radii, typography, spacing, alignment, theme colors, hover and tooltips, and the assigned, recording, and unassigned states. Held press, exact frame timing, and live Narrator were not checked.

- **Silent launch checks**: Headless `features/settings/settings.test.tsx --filter "silent launch:"` covers the switch off by default, the saved value, the running window staying open after the switch, the next launch keeping the window hidden (`app.window("main").state()`), a normal launch showing it again, and a failed write that keeps the saved state. The Windows desktop run of the same filter passed the launch check in a real window, and the host logged `the main window starts hidden (nsh.json window.defaultVisible: false) until the app shows it`; its module-stubbed failure test cannot run with `--target windows`, as the other stubbed tests in this file. Format check, lint, `nsh check`, the headless suite, and the release build passed. Windows screenshots at 1040 × 720 (light `zh-CN` and `en`, dark `zh-CN`) confirmed the card's radius, typography, spacing, alignment, token colors, and checked and unchecked tracks; held press, frame timing, and live Narrator were not checked. The macOS and Linux runners were not available here, so their launch visibility is unverified.

- **Screenshot shortcut checks**: `mise run verify` passed (426 passed, 2 skipped). The native Windows shortcut test saved independent bindings. Windows returned `ERROR_HOTKEY_ALREADY_REGISTERED` for `Alt+Shift+S` on the test machine, and the card showed the inactive state. Light (`en`, `1040 × 720`) and dark (`zh-CN`, `720 × 520`, reduced motion) screenshots confirmed the shared card radius, type scale, divider, spacing, alignment, theme colors, focus ring, and recording and error states. Held press, exact frame timing, and live Narrator were not checked in this pass. Both native overlay tests passed separately. The headless flow test confirmed that the popup stays closed during selection, opens for recognition, and translates once.

## Screen selection overlay

Both the toolbar OCR action and the **Screenshot Translate** global shortcut use this overlay. When Quick Translate is already open, it hides while the selection runs. Otherwise the shortcut opens the overlay directly, without showing the popup first. A confirmed selection opens or restores Quick Translate before it recognizes and translates the text. The capture takes one in-memory snapshot per active display and shows a frameless selection surface over each display's full bounds (physical pixels, not work areas). Nothing is written to disk, and no snapshot reaches TSX: only the confirmed crop's PNG crosses the native bridge.

- **Surfaces**: one `WS_EX_TOPMOST | WS_EX_TOOLWINDOW` popup per display, sized to that display's physical rectangle and painted with its own snapshot at 1:1. The surfaces cover the taskbar and stay above every other window; the mouse pointer is the cross display, so the drag itself states the mode. At most one session runs at a time, and a display topology change (`WM_DISPLAYCHANGE`) ends it as a cancellation. All surfaces, snapshots, and capture handles release together when the session ends.
- **Pointer selection**: pointer-down chooses the display and anchors the corner. A 40% black mask dims each snapshot outside the current selection, including displays with no selection. Each display's dimmed preview is composed once in memory. The capture worker composes the bright selection, frame, crosshair, and caption in a shared back buffer. It copies the complete frame to the window in one operation. It repaints only the displays whose overlay content changes. A `1` physical-pixel frame alternates black and white `6` pixel dashes, so the dashed edge stays visible on light and dark content. Dash positions are anchored to the display, so resizing the selection never slides the pattern. The mask and strokes are preview only. Release confirms a nonempty rectangle; a drag that leaves the starting display stops at that display's edge, and a click without movement leaves no selection. The crop is the anchor display's pixels only.
- **Keyboard selection**: a low-level keyboard hook makes the keys work whatever window holds the focus, and swallows them so the app behind never receives them. `Tab` moves to the next display, a dotted crosshair follows it, the arrow keys move that crosshair by `8` physical pixels, `Space` anchors it, the arrows then adjust the opposite corner, `Enter` confirms a nonempty rectangle, and `Esc` cancels at any stage.
- **Instruction band**: the active display's top center carries one `text` line from `ocr.capture.instruction` in `text-foreground` over the `background` fill, both taken from theme tokens and sent with the request. The capture worker converts the RGB channels to opaque Win32 colors; it uses a high-contrast pair if a token is invalid. Every other display shows its masked snapshot and any selection or crosshair.
- **Motion**: none. The mask appears with the overlay. Its opening, the frame, the crosshair, and the instruction track the pointer and keys directly with no animation. Reduced motion does not change this behavior.
- **Failure and cancellation**: Cancelling or a topology change restores an existing Quick Translate window and leaves the draft untouched. If the shortcut started without a popup, cancellation stays on the desktop. Errors use the existing inline OCR alert. A crop whose PNG exceeds the OCR upload limit fails with the "select a smaller area" message instead of uploading.
- **Windows rendering check**: `cargo test --lib desktop_overlay_ -- --ignored --test-threads=1` reads the pixels of a real overlay with a known white background. It verifies that the selected pixels remain white and that the rest dims to `#999999` as the selection moves. It also checks that the light and dark captions show text and that a drag does not invalidate a second overlay window. A headless test paints the frame into a memory bitmap and requires alternating black and white dashes on the selection edge.

## Quick Translate popup

Quick Translate runs inside a separate floating NSH window (`id="quick-translate"`) rather than an in-window modal so the popup stays lightweight and available even when the main window is hidden.

- **Frameless floating shell & concentric geometry**: Opens near the active cursor on Windows (or centered fallback) with an initial size of `420 × 360` points and a minimum of `340 × 120` points. After layout, the window height follows `header + content + footer + ROOT_BORDER_HEIGHT` (`2` pt for the `1` pt top/bottom perimeter border) up to the display's work area, keeping the current width and shifting the top edge only when needed to stay inside the work area. The window opens with `kind="panel"`, `level="floating"`, `frame="none"`, `transparent={true}`, `taskbar={false}`, `minimizable={false}`, and `maximizable={false}`. The root container (`overflow-hidden rounded-3xl border border-border bg-background text-foreground`) renders `24` pt outer corners bounded by a crisp `1` pt `border-border` perimeter. Inside, all four vertical bands (`quick-translate-header`, source section, result cards container, and `quick-translate-footer`) share a `16` pt (`px-4`) leading and trailing spine. Result `<Card variant="subtle">` containers use `12` pt (`rounded-xl border border-border bg-surface-subtle`) corners, concentric with `6` pt (`rounded-md`) compact `size="icon-xs"` (`24 × 24` pt) icon buttons and `h-6` (`24` pt) `variant="chip"` `<Select>` triggers (`bg-surface-control`). With `frame="none"` (`titleBar()` metrics `0`), a `44` pt header (`Math.max(44, titleBar().height)`, `desktop={{ windowDrag: true }}`, `border-b border-border/80`) sets `paddingLeft: titleBar().left + 16` and `paddingRight: titleBar().right + 16` so outer controls align on the `16` pt spine and clear the `24` pt top corners.
- **Top bar language capsule & tool controls**: On the leading side of the header, `QuickTranslateLanguageBar` presents one `h-7 rounded-full bg-muted px-1` capsule containing an inline source language `<Select variant="inline">` (displaying `自动` / `Auto` at rest, `正在检测` / `Detecting` while detection runs, and `自动 (<Language>)` / `Auto (<Language>)` once auto-detected), a circular `size="icon-xs"` swap button (`quick-translate-swap-languages`, disabled when source is unresolved automatic or identical to target), and an inline target language `<Select variant="inline">`. Both capsules carry a pointer-only label tooltip (`labelTooltip` → `buildHoverTooltip`: `delay={Infinity}` with an app-owned `open`, styled like every other tooltip), so a label the cramped chip truncates (`Auto…`, `Automa…`) reads whole on hover, while the keyboard focus never arms a tooltip that would absorb the `Escape` closing the popup; the tooltip leaves when the dropdown opens and returns only after the pointer leaves and comes back. The source list names the automatic choice after the language the last action auto-detected (`Auto (French)` / `自动 (法语)`) while the trigger keeps reporting `正在检测` / `Detecting` in flight; shared `<Select>` popups set `margin={8}` so compact windows retain bottom shadow and corner clearance. On the trailing side, `28 × 28` pt (`size="icon-sm"`) buttons provide **Auto-translate** (`brand-ghost`, `lightning` / `lightning-solid`), Windows-only **Read text from screen** (`scanning`), and **Pin** (`brand-ghost`, `pin` / `pin-solid`), separated by a `h-3.5 w-px bg-border` hairline from the **Close** button (`destructive-ghost`, `close`). Overlays (`Select`, `Menu`) mount on the window root above the clipped surface so `overflow-hidden` clips inner scrolled content without clipping popovers.
- **Frameless source composer & unified status line**: The scrollable body opens directly on `bg-background` with a frameless `<Textarea variant="frameless">` (`submitBehavior="submit"` so pressing `Enter` triggers translation and `Shift+Enter` inserts newlines while IME composition ignores `Enter`, `fontScale="stepped"`, `inputClass="min-h-10"`). **Collapse/Edit input** (`collapse-text-input` → `edit`) and **Clear input** (`close-circle`) sit in a top-right `shrink-0 gap-1` cluster beside the input when text is non-empty, leaving empty state free of toolbars. Below the source input or collapsed preview (`quick-translate-source-toolbar`), a `size="icon-xs"` **Read aloud** button (`speaker-one`) appears whenever non-whitespace source text exists, in the editor and in the collapsed preview. It stays disabled, with a Settings reason, until Google Cloud Text-to-Speech is enabled. An enabled press sends the whole source, not the first line. Hover, press, and tooltip opacity stay on the existing icon button. Reduced motion is instant and does not scale. Synthesis, playback, and errors update the glyph, tooltip, accessible name, and inline alert immediately, with no new animation, alongside a single OCR status slot (`OCR error > OCR recognizing`). The glyph is `close-circle` while the request is in flight and `pause` (`icon-park-outline--pause.svg`) while the clip plays.
- **Engine comparison cards**: Ordered preset cards render with `<Card variant="subtle">` (`gap-0 p-0 rounded-xl border border-border bg-surface-subtle`): a compact header (`px-3 py-2.5`, `gap-1.5`) holds a content-sized `<Select variant="chip">` for the preset (with a leading outline DeepL hexagon-node mark, known AI channel provider mark, or `size-1.5 rounded-full bg-brand` dot), an AI-only template `<Select variant="chip">`, and trailing `size="icon-xs"` **Collapse/Expand** (`chevron-up` / `chevron-down`) and **Remove** (`close`) icon buttons. Translation results render at `text-base leading-relaxed text-card-foreground` (`selectable`). When a card succeeds, a subtle `border-t border-border/60` footer (`px-2 py-1.5`) places **Read aloud** (`speaker-one` while idle, `close-circle` while its request is in flight, and `pause` while that card plays; only for non-whitespace successful output; disabled until Google Cloud Text-to-Speech is enabled) and **Copy** (`copy` → emerald `check`) on the leading side and **Retry** (`refresh`) on the trailing side; error cards show **Retry** on the trailing side.
- **Persistent footer bar**: Outside `<Scroll>`, `QuickTranslateFooter` (`border-t border-border bg-surface-subtle px-4 py-2`) places the labeled **Add preset** `Menu` trigger (`plus` icon, opening upward with `placement="top" align="start"`) on the leading side and `<Kbd>↵</Kbd> Translate` / `<Kbd>Esc</Kbd> Hide` hints on the trailing side.
- **Collapsed source preview**: **Collapse input** replaces the `<Textarea>` with a compact one-line preview button (`id:quick-translate-source-preview`, `h-8 min-h-0 rounded-lg bg-surface-subtle px-2.5 hover:bg-accent`) aligned to the `16` pt spine, showing only the first line (`truncate text-sm text-foreground`) plus a static `chevron-down` (`size-3.5`, `text-muted-foreground`) when multiline, beside the top-right **Edit input** and **Clear input** actions. Pressing the preview or **Edit input** returns to the editor, focuses the field, and puts the caret past the last character. An empty draft always returns to the editor, and every double-copy or selection delivery re-collapses the preview on the delivered draft.
- **Stepped source type**: The open source editor (`fontScale="stepped"`) uses `text-2xl`, `text-xl`, `text-base`, and `text-sm`, largest first (`font-medium` on `text-2xl` / `text-xl`, `font-normal` on `text-base` / `text-sm`, applied identically to `FontProbe` and `BaseInput`). Empty text stays on `text-2xl`, which still fits the empty field's existing minimum height. With text, the field keeps the largest step whose wrapped height fits six rows of the 16pt body size (`text-base`), scaled with the user's text size; past that it stays on `text-sm` and the window scrolls as before. The budget follows the editor width, not its current height, so shrinking the type does not immediately grow it again. A measure that collapses to one line is ignored. If the field itself is still taller than the budget, the step moves down and does not jump back up for that same text and width. The collapsed preview stays `text-sm`. The remembered step is view-only and is not stored in `quickTranslate.preferences.v1`.
- **Colors & copy**: Uses semantic surface/text/border/accent tokens only (`bg-background`, `bg-surface-subtle`, `bg-surface-control`, `bg-muted`, `bg-popover`, `bg-brand`, `bg-brand-soft`, `text-foreground`, `text-card-foreground`, `text-popover-foreground`, `text-muted-foreground`, `text-destructive`, `text-success`, `border-border`, `ring-ring`); no hard-coded presentation hex/RGB colors. Copy stays bare and localized via `t()`.
- **Clipboard delivery**: Text copied by double `Ctrl+C` opens or reuses the window and translates at once with the enabled cards, independent of **Auto-translate**. The delivered draft arrives collapsed as the one-line preview, so the popup shows the source and results without taking keystrokes, and **Edit input** returns to the editor. Typing, paste, and language changes still follow that toggle and its `500 ms` debounce. A copy with nothing to translate leaves the current draft and result in place.
- **Scroll & focus ownership**: One vertical `<Scroll>` container inside the popup body owns scrolling across the source composer and ordered preset result cards, while header and footer chrome stay pinned. Source `<Textarea>` takes focus when opened or re-focused; opening the header Source/Target `<Select>` overlays, the footer **Add preset** `Menu`, or any card `<Select>` overlay stays inside the popup window tree without blurring it, and `Escape` dismisses open overlays before closing the window (`closeOnEscape={!hasOpenOverlay()}`). Unpinned blur closes the window and resets pin on every close path without quitting the app.
- **Preferences & privacy boundaries**: Quick Translate restores only explicit user preferences (`quickTranslate.preferences.v1`: `doubleCopyEnabled`, `autoTranslate`, `sourceLanguage`, `targetLanguage`, and ordered `{ id, presetId, templateId, collapsed }` cards after `presetsStore` finishes loading, dropping missing/disabled presets and deleted template overrides). `sourceLanguage` and `targetLanguage` accept the shared `auto` sentinel, and a missing saved selection starts as Automatic; no preset supplies default languages. Draft text, translation outputs, detected languages, pin state, errors, keystroke history, and API credentials are never persisted there; shortcut registration conflicts warn cleanly without blocking startup and fall back to the tray menu.
- **Shared language resolution**: Each translation action captures one immutable text, selection, and Language Detection settings snapshot. When either selection is automatic, that action creates one lazy resolution run, and every eligible expanded card joins it after its own guards, so the detector is asked once per action; a standalone retry or expand starts a run of its own. The run has its own `AbortController` and aborts when its last consumer leaves (collapse, Clear, language or text change, or window close), and no successful or failed resolution is retained across actions. Cards keep the user's selections: detected or calculated languages reach only the outgoing prompt. Blocked detection shows the same localized recovery text on every affected card and sends no translation request. While `sourceLanguage` is `auto`, the header source capsule surfaces transient progress (`Detecting` / `正在检测`) while in flight and updates to `Auto (<language>)` / `自动 (<language>)` upon resolution, guarded by a monotonic run sequence so edits, clears, language changes, aborts, or failures revert the capsule to `Auto` / `自动` immediately without placing detection status below the source composer.
- **DeepL cards**: A DeepL card joins the same shared resolver as an AI card and sends the resolved pair with the preset's stored key to the Free or Pro host. It shows the `text-muted-foreground` translating status and then the complete translation in one state swap, with no streamed chunks, per-token animation, or shimmer. The template selector is hidden and any stale template override is ignored; Copy, Retry, and cancellation behave like AI cards.
- **Streamed results**: A card shows the `text-muted-foreground` translating status, then replaces it with the growing translation as chunks arrive. The partial text is selectable and shows no per-token animation; Copy and Retry appear only after the stream ends. A stream that stops early keeps the partial text above the `text-destructive` error and its Retry action, and no partial text is ever copyable. Language detection stays a buffered, single-response request so a card never waits on a streamed detector.

### Windows selection acceptance

Tested My Translator 0.1.0 at `5cb0c2d`. Repeated the core selection and screenshot checks at `eaf0e99`. These results apply to the tested surfaces, not to all pages or app versions.

| App version | Surface | Result with `Alt+D` |
| --- | --- | --- |
| Notepad 11.2609.11.0 | Document text | Translated the full selection once. |
| Chrome 157.0.8103.79 | Google Search results | Translated the full selection once. |
| Word 16.0.20527.20196 | Document body | Opened Quick Translate and translated the selection. |
| Chrome 157.0.8103.79 | X page | Opened Quick Translate without changing the draft or results. No translation started. |
| VS Code 1.146.0 | Editor | Same as the X page. |
| Adobe Acrobat DC 21.001.20155 | PDF text | Same as the X page. |
| Windows Terminal 1.25.261109001 | Terminal output | Same as the X page. |

- **Live checks**: Notepad and Chrome translated with both Auto-translate and double-copy off. In separate Windows tests with a local HTTP fixture, Notepad and the Chrome test page each sent one request with the full selection. For each app, the foreground probe recorded a run with no intervening foreground window before Quick Translate appeared. The popup opened about 15 physical pixels from the pointer on each axis. Some other probe runs could not identify the first foreground window, even though translation completed. A fast focus change did not open a stale popup. Holding the shortcut did not repeat the translation. Pin state and clipboard contents did not change. The tray opened Quick Translate. Clearing `Alt+D` restored address-bar focus in Edge 157.0.4341.60 and File Explorer.
- **Windows settings**: Inspected four combinations of light, dark, `en`, and `zh-CN` at `1040 × 720` and `720 × 520` points. No label clipping was visible. Hover feedback and keyboard focus were visible. Recording and Escape worked, including at the compact size with reduced motion. The native shortcut test also covered saving, clearing, and resetting.
- **Automated checks at `eaf0e99`**: `mise run verify` passed (437 passed, 6 skipped; build succeeded). The four interactive UI Automation tests passed. Double-copy passed its headless and Win32 worker checks. Screenshot Translate passed its headless, native overlay, and Windows end-to-end checks. The last check used the global `Alt+Shift+S` shortcut, confirmed a crop in the real overlay, sent one PNG to a local OCR fixture, and displayed the translated result. No external provider received the crop.
- **Desktop suite**: Native cursor and shortcut tests passed. `mise run test-desktop` stopped at `App.test.tsx` (3 passed, 16 failed), so later files did not run. The pre-selection baseline `ffe4677` reproduced the same failures. With English set in an isolated test fixture, 18 of 19 cases passed. The remaining assertion still found the page after the window reported that it was hidden. This does not count as a passing desktop run.

The development transcript has these red and green results. Times are UTC on 2026-11-21.

| Case | First relevant failure | Passing run |
| --- | --- | --- |
| Native selected range | 11:37:55 — Expected `Selected`, got `Unavailable`. | 11:45:44 |
| Selection shortcut to translation | 11:51:57 — The test timed out waiting for the read to start. | 11:54:41 |
| Close during read | 11:58:32 — The result reopened the popup. | 11:59:06 |
| Changed draft or target | 11:59:43 — The result opened the popup after an edit. | 12:00:07 |
| Overlapping reads | 12:03:01 — Three reads started instead of one. | 12:05:39 |
| Empty or failed read | 12:07:30 — A current empty result did not open the popup. | 12:07:44 |
| OCR region overlay | 12:12:06 — A selection read started while the overlay was active. | 12:12:32 |
| OCR recognition | 12:13:58 — Recognition stayed busy after selection delivery. | 12:15:37 |
| Shortcut conflict and replacement | 12:19:14 — Existing shortcut priority passed; the rejected replacement test timed out waiting for its alert. | 12:26:09 |
| Native `stale` with matching window handles | 14:02:30 — The result opened a closed popup and focused an open one. | 14:02:48 |

The transcript has passing results for the native caret, password, and lost-foreground cases at 11:47:30. It does not show a separate red run for each of these three cases.

### Temporary Windows line-height workaround

[NSH #2655](https://github.com/longbridge/nsh/issues/2655) makes the gap below the last line grow with every line in a
Windows multiline input. On NSH 0.6.1, [the Quick Translate source input](../../features/quick-translate/popup.tsx)
uses `leading-[0]` on Windows so the layout uses the font's natural line height. The offscreen measure does not
copy that workaround: on a text node it collapses the height and the large step looks like it still fits. Scroll
ownership stays the same. Other textareas and platforms keep their current styles.

**Remove after the upstream fix:** When upgrading NSH, test with the override disabled. Run the issue's minimal
reproduction, then check Quick Translate with explicit line breaks and wrapped text on Windows at 150% scale. If
the gap no longer grows and the last line stays visible, restore `inputClass="min-h-10"` on all platforms and remove
the TODO and this note. Keep the shared textarea's `overflow-hidden`; it fixes a separate scroll-range bug.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Quick Translate window show, focus, and close | Native `<Window>` show/focus/hide lifecycle (`level="floating"`, `closeOnBlur={!pinned && !dismissalSuspended}`, `closeOnEscape={!hasOpenOverlay && !dismissalSuspended}`) | Immediate native show/close |
| Header controls (Auto-translate, OCR, Pin, Close, Swap), source actions (Collapse/Edit, Clear), card actions (Collapse, Remove, Copy, Retry), and footer Add preset button | Shared `motion.navigationFeedback` (`150 ms`, ease-out colors) + `motion.pressScale` (`active:scale-95`), persistent `selected:bg-brand-soft` on active toggles (`Auto-translate`, `Pin`), `destructive-ghost` wash on `Close`, focus-visible ring (`ring-ring`) | Instant color/ring, `scale-100` |
| Source/Target language `<Select variant="inline">` and card Preset/Template `<Select variant="chip">` triggers and overlays | Trigger hover/focus/active washes via `motion.navigationFeedback` without press scale; shared `Select` `Overlay` popup (`motion.popup` / `motion.popupHidden`, `150 ms`, ease-out, `-translate-y-1` reveal inside popup root); list item washes via `navigationFeedback` | Instant opacity/color, no slide |
| Footer Add preset `Menu` overlay | Shared `Menu` + `MenuItem` overlay (`motion.popup`, `motion.popupHidden`, `150 ms`, ease-out, `placement="top"` inside popup root so native blur does not fire) | Instant opacity, no slide |
| Icon-only control tooltips (Swap, Auto-translate, OCR, Pin, Close, Collapse/Edit source, Clear source, Collapse/Remove card, Copy, Retry) | Shared `buildTooltip` (`motion.tooltip`, `150 ms`, ease-out opacity) | Instant opacity |
| Toggle glyph swaps (`lightning` ↔ `lightning-solid`, `pin` ↔ `pin-solid`, `copy` ↔ `check`, `chevron-up` ↔ `chevron-down`, `collapse-text-input` ↔ `edit`) | Immediate icon swap paired with `motion.navigationFeedback` (`150 ms`, ease-out) button background/tint feedback | Instant |
| Window fits content after header, body, or footer changes | Immediate single-frame `setBounds` update (`header + content + footer + ROOT_BORDER_HEIGHT`) without interpolation, keeping content height in sync and scrolling overflow in `<Scroll>` | Same immediate bounds update |
| Source composer collapse / expand preview & stepped source type | Immediate conditional `<If>` swap between frameless stepped `<Textarea>` (`text-2xl` … `text-sm`) and `quick-translate-source-preview` (`h-8`); no transition on mode or font step | Same immediate swap |
| OCR status & source auto-detection line (`quick-translate-source-toolbar`) | Immediate conditional swap in priority order (`OCR error > OCR recognizing > source auto-detection`) and source capsule detected label update; no shimmer or spinner | Instant |
| OCR action press, capture selection, and recognition | Immediate: `disabled` while selecting/recognizing; popup hides and returns with no transition; focus returns to OCR trigger on cancel/failure | Instant |
| Ordered preset cards (`idle` → `loading` → `streaming` → `success` / `error`, card add/remove/collapse) | Keyed `<Each key={(card) => card.id}>` updates inside `<Scroll>`; streamed text updates in place without per-token animation or shimmer; card footer Copy/Retry bar appears immediately on completion/error | Instant |

- **Visual unification & spacing audit**: Inspected 6 rendered Windows `--target windows` PNG screenshots (`zh-CN`, 150% DPI scaling) covering Light (`idle` 1-card, `translated` 3-line auto-detected English source + Chinese result, hovered **Clear input**, and HTTP 429 error with hovered **Retry**) and Dark (`translated` and hovered **Close**). Finishing checklist status:
  - *Radius & concentricity*: Passed — root `rounded-2xl` (16 pt), both `<Textarea variant="card">` and preset `<Card>`s share `rounded-xl` (12 pt), `<Select>` uses `rounded-lg` (8 pt), and uniform `size="icon-sm"` buttons use `rounded-md` (6 pt) at `6` pt card inset (`12 − 6 = 6` pt concentric hover washes verified on Clear, Retry, and top-right Close).
  - *Typography, color & surfaces*: Passed — `text-sm`/`text-xs` scale steps only; both source and result cards share `bg-card`, `text-card-foreground`, `border-border`, and `ring-ring` focus treatment with balanced Light and Dark contrast (`<Textarea>` default variant for form fields remains unchanged).
  - *Spacing, gaps & alignment*: Passed — `40` pt header with `12` pt edge inset matches `p-3` (`12` pt) body margins and `gap-2` (`8` pt) card separation; left spine (`12` pt text / `13` pt Copy glyph), right spine (`6` pt button / `13` pt Clear/Remove/Retry glyphs), and `12–13` pt bottom margins align across cards without negative margins; idle 1-card height fits cleanly under `220` pt (`quick window fits cards...` passed).
  - *Hover, component standards, motion, accessibility & platforms*: Passed for inspected hover washes, uniform `size="icon-sm"` controls, localized `accessibilityLabel`s, and Windows Light/Dark rendering; held-press (`active:`), frame-by-frame motion timing, and interactive Windows Narrator speech remain manual desktop checks.
- **Title-bar language menu & compact layout audit**: Inspected rendered Windows `--target windows` PNG screenshots across Light (`zh-CN` and `en`) and Dark (`zh-CN`) covering rest state (initially audited at `420 × 230`, later refined via `POPUP_MIN_SIZE.height = 120` to `420 × 194` 1-card fit ending `10` pt under the preset card and `420 × 132` 0-card fit ending `10` pt under `<Textarea>` in both Light and Dark), open root language menu (`w-48 max-h-44`, `Source` / `Target` rows with `MenuSeparator` and trailing `chevron-right`), hovered Source and Target submenus (`offset={4}` opening cleanly beside the root menu below the title bar with zero overlap, radio checkmark on active language, single-line `"Source: Portuguese"` / `"Target: Japanese"` with aligned chevrons), and Enter-triggered translation output. Hovering item 2 (`Target`) can nudge the root menu scroll container slightly (~12 px) when NSH focuses the hovered item inside `BaseMenu`; `Escape` dismisses submenu then root menu without blur closing the window (after closing a submenu via `Escape`, one extra `Escape` is absorbed by NSH's menu stack before `Window` `closeOnEscape` fires). Held press states, `340` pt minimum-width menu inspection, frame-by-frame motion timing, and Narrator verification remain manual desktop checks.
- **Adaptive height audit**: Windows at 150% display scaling (`420 × 194` 1-card rest state, `420 × 132` 0-card state after removing the last card, and `90`-line work-area clamp). Light (`1`-card, `0`-card, and long result) and Dark (`1`-card) screenshots show the same concentric radii, symmetric `p-2.5` (`10` pt) outer margins around the bottom edge, typography, alignment, and token colors. Card add, remove, collapse, and expand update the bounds without animation. A 90-line result reaches the work-area limit; wheel scrolling reaches its Copy and Retry actions while the title bar stays visible.
- **Language resolution checks**: The shared popup run is covered headlessly and on the Windows development host (`--target windows --filter "language resolution:"`, 6/6): one detection request for two expanded cards with zero translation traffic until it settles, a collapsed card that neither starts nor joins the run, the same localized recovery text on every affected card with no translation request, an abort when the last consumer leaves, and a fresh run on retry. A separate case runs the real detector through the saved detector endpoint.
- **Title-bar add-preset layout audit**: Inspected rendered Windows `--target windows` PNG screenshots across Light (rest state with translated card and open leading `+` menu) and Dark (`zh-CN`). Verified **Add preset** (`plus.svg`) aligns cleanly beside Language and Auto-translate in the leading title bar with `size="icon-sm"` and opens a bottom-start `rounded-xl` popover directly below the header without clipping or blur dismissal, while `gap-2` cleanly separates `<Textarea>` from the preset cards without an intervening hairline divider.
- **Source composer footer & detection status audit**: Inspected rendered Windows `--target windows` PNG screenshots across Light (empty `min-h-10` floating window, 3-line English input, 3-line English input with live auto-detection `自动检测：英语` in `PopupHarness`, and multi-line Chinese input) and Dark (multi-line Chinese auto-detection `自动检测：中文` + hovered **Clear input** tooltip `"清除输入"`). Verified `inputClass="min-h-10"` (`40` pt) avoids forcing blank extra height beneath 3-line inputs while keeping empty state multi-line, and borderless `-mt-1 pb-1.5 pl-3 pr-1.5` (`min-h-5`, `size="icon-xs"` `20 × 20` pt `rounded-sm` concentric inside `rounded-lg`) places the footer status and **Clear input** icon directly beneath the last input line at the same visual cadence as body line spacing without touching descenders, aligns status text strictly to the input left spine (`pl-3`), keeps hover tooltips unclipped in Dark mode, and hides detection status for explicit source languages, edits, clears, aborts, and detection failures.
- **Collapsed source preview audit**: Inspected rendered Windows `--target windows` PNG screenshots across `en` Light (multi-line expanded draft and its collapsed one-line preview), `en` Dark (hovered **Edit input** tooltip on the preview), and `zh-CN` Light/Dark (CJK truncation and `编辑输入框` tooltip). Verified the preview keeps the first line on the expanded editor's baseline (`h-10`, `px-3`), the `rounded-t-xl` hover wash fits inside the `rounded-xl` card without clipping, long single-line and CJK drafts ellipsize instead of widening the window, the static `chevron-down` marks hidden lines at the trailing edge, and the footer toolbar keeps its `px-1.5 pb-1.5` position. Live Narrator speech remains a manual desktop check; the mode has no animation to time.
- **Icon-only action bar audit**: Inspected rendered Windows `--target windows` PNG screenshots across Light (`zh-CN` rest state and hovered Copy tooltip `"复制"`) and Dark (`zh-CN` green `check` copied state + HTTP 429 error card with trailing `refresh` retry icon). Verified uniform `size="icon-sm"` (`28 × 28` pt, `rounded-md`) `variant="ghost"` geometry and `size-3.5` `icon-park-outline` stroke weight across the header, **Clear input** / **Add preset** toolbar, card header, and card footer; aligned trailing `add-preset` / `remove` / `retry` edges along clean inner/outer card spines; verified hovered `buildTooltip` (`bg-sidebar-primary` / `text-sidebar-primary-foreground`) renders unclipped above the card footer in Light mode and swaps to `Copied` (`role:button[Copied]` / `已复制`) with emerald `check` (`tone="success"`) while active. Also added missing `tooltip` props to existing icon-only actions in `Input` (`common.clearInput`), `PresetsPage` skipped-notice dismiss (`presets.list.dismissSkippedNotice`), and `ChannelsRail` row reorder buttons (`moveUp` / `moveDown`).
- **Rounded frameless surface audit**: Inspected rendered Windows `--target windows` PNG screenshots at 150% DPI scaling across Light (`zh-CN` rest state and open Language `Menu`) and Dark (`zh-CN` hovered `Close` button and 40-line translated card with `清除输入` / `复制` / `重试`). Verified concentric `16` pt `rounded-2xl` window corners with a crisp `1` pt `border-border` perimeter harmonious with the `12` pt `<Card>` (`rounded-xl`, `p-2.5` gap), `8` pt `<Textarea>`/`<Select>` (`rounded-lg`), and `6` pt `icon-sm`/`xs` buttons (`rounded-md`); exact `ROOT_BORDER_HEIGHT = 2` sizing without spurious overflow; unclipped `Menu` overlay above `overflow-hidden`; clean top-right curve clearance for the hovered Close button highlight; and clean bottom border framing on long expanded results. On Windows DirectComposition (`DXGI_ALPHA_MODE_PREMULTIPLIED`) live window corners composite transparently without native DWM shadow, while `nsh` test `snapshot()` RGB PNG readback renders cleared transparent corner pixels as black.
- **Earlier visual audit & Finishing checklist**: Inspected rendered Windows `--target windows` PNG screenshots covering the initial `420 × 360` floating popup (Light `en` multiline input), HTTP 429 error card with `Retry` (Light `en`), multi-card result (Dark `zh-CN`, `reducedMotion: true`), and Settings → General Windows double-copy card (Light `en` and Dark `zh-CN`). Fixed reactive `titleBar().right` clearance in `QuickTranslateWindowBody` so header Auto/Pin icons clear the native Win32 caption close button without overlap, and paired **Clear input** beside **Add preset** cleanly so single-card error/result cards fit inside the initial `360` pt frame without clipping. Verified semantic colors, card/input/button radii, typography contrast, spacing, overlay Escape handling, keyboard Enter/Shift+Enter/IME guards, and reduced-motion state updates; manual interactive desktop spot-checks remain noted for the global Quick Translate shortcut from another app, live multi-app double-`Ctrl+C` settlement, and interactive Narrator/DPI drag checks.

- **Screen OCR**: The leading title-bar group carries a ghost `icon-sm` **Read text from screen** action (`quick-translate-ocr`, `pic.svg`, outside the drag region) on Windows only. Activating it snapshots and shows the native selection surfaces (see **Screen selection overlay**); the window hides for the selection and returns with its pin state before the model is asked, while blur, Escape, and outside-press dismissal stay suspended and shortcut or double-copy activations are ignored. The selection's instruction line and colors come from `ocr.capture.instruction` and the theme tokens. Recognition shows `quick-translate-ocr-busy` (`Reading text…`) in `quick-translate-source-toolbar`. Typing or a valid double-copy delivery aborts the request; a recognized answer replaces the draft whole with its line breaks, opens the editor, and places the caret after the text, which also clears any queued typing debounce so only one translation action follows. A blank answer, a provider or timeout failure, and an unusable saved model keep the draft, start no translation, and show `quick-translate-ocr-status` inside `quick-translate-source-toolbar`; the unavailable case needs no capture at all. A closed popup, a newer delivery, or an edited draft discards the late result and never reopens the window.
- **Screen OCR checks**: `mise run verify` passed formatting, lint, Rust and TypeScript checks, all headless tests (383/383), and the release bundle. `nsh test features/settings/settings.test.tsx --filter "ocr settings:"` (3/3), and `nsh test app/quick-translate.test.tsx --filter "quick ocr:"` (9/9), plus `features/quick-translate/popup.test.tsx` (27/27), cover the OCR category and image-capable choices, replacement with line breaks, one translation action, cancellation with no request, blank answers, provider failures, typing and repeat presses during recognition, close and reopen before a late result, a queued auto-translate debounce, a card-less popup, and the Windows-only action. `cargo test --test screen_capture` covers the crop math (5/5).
- **OCR follow-up checks**: `mise run verify` passed (387 tests passed and one interactive test skipped). On Windows, `cargo test --lib desktop_overlay_confirms_and_cancels_on_keyboard_messages -- --ignored` created the real overlays, confirmed an 8 × 8 PNG crop with queued keyboard messages, and cancelled a second selection. Windows settings and popup tests verified service selection and save, unavailable-model recovery, replacement and immediate translation, and double-copy takeover with no late OCR overwrite. The popup tests used capture and HTTP fixtures. Physical multi-display and mixed-DPI coverage, visual checks, and recognition with a live provider remain manual.
- **Unified OCR footer status audit**: Moved `quick-translate-ocr-busy` and `quick-translate-ocr-status` into `quick-translate-source-toolbar` alongside `quick-translate-source-detection` (`OCR error > OCR recognizing > source auto-detection`). Verified via `features/quick-translate/popup.test.tsx` (28/28 headless; new priority/collapse slot test passed on `--target windows`), `app/quick-translate.test.tsx --filter "quick ocr:"` (11/11 headless; 9/9 Windows-applicable cases passed on `--target windows`, while the 2 headless-only close-button/non-Windows-platform simulations apply to headless runs), and 4 rendered Windows `--target windows` PNG screenshots covering Light `zh-CN` (empty input with malformed-answer alert), Light `en` (text + 2-line wrapped unconfigured alert with `items-end` trailing Collapse/Clear buttons), Dark `zh-CN` (recognizing `正在识别文字…` with `text-muted-foreground`), and Dark `zh-CN` (collapsed one-line preview with OCR alert). Confirmed concentric `rounded-2xl` / `rounded-xl` / `rounded-md` radii, `12` pt left spine alignment across expanded/collapsed source text and toolbar statuses, no top layout jump above `<Textarea>`, and clean Light/Dark contrast on `bg-card`. Held-press states and live Windows Narrator announcements remain manual desktop checks.
- **UI optimization visual & desktop audit**: Inspected 10 rendered Windows `--target windows` PNG screenshots covering Light (`zh-CN` idle, open compact-height target `<Select>`, open upward `+ 添加翻译预设` `<Menu>`, 3-card OpenAI + DeepL + Custom dot translation with copied check, and stepped multi-line English paragraph; `en` active `brand-soft` Auto-translate and Pin buttons, collapsed preview with multiline chevron, Concise template chip, DeepL API-key error, and collapsed Custom card; `340` pt narrow width) and Dark (`zh-CN` `reducedMotion: true` active Auto + Pin with 3 cards; `en` `reducedMotion: true` collapsed preview, DeepL error card, open card preset `<Select>`), 4 Windows screenshots verifying unified `自动` / `自动 (<language>)` labels and disabled `speaker-one` placeholders under non-whitespace source and beside **Copy**, plus 3 Windows screenshots confirming transient header-capsule detection progress (`正在检测` / `Detecting` → `自动 (法语)` in Light `zh-CN` and Dark `en` with `reducedMotion: true`) without status text beneath the source composer. During review, added `margin={8}` to `<Select>` so compact dropdown corners clear the popup bottom edge, redrew `assets/icons/deepl.svg` as an outline hexagon with three connecting nodes to match OpenAI and `icon-park-outline` stroke weight at `12` pt, and removed text-label `<Select>` tooltips in `QuickTranslateLanguageBar` so `Escape` closing a dropdown restores focus without arming a tooltip that intercepts the window-closing `Escape`. All 7 `desktop:` tests in `app/quick-translate.test.tsx` passed on `--target windows` (`features/quick-translate/popup.test.tsx --filter "desktop:"` hit `app.type` center-click behavior after `Shift+Enter` inside a `min-h-10` multi-line field on `--target windows`, 1/2). Held-press `active:` visuals, live motion frame pacing, and Windows Narrator speech remain manual desktop checks.
- **Language capsule tooltip & detected auto item audit**: `mise run verify` passed formatting, lint, Rust and TypeScript checks, 460 headless tests (8 skipped, 0 failed), and the release bundle. Headless `features/quick-translate/popup.test.tsx` passed 31/31, including a new hover-tooltip case (source `English` and target `French` read whole on hover, the tooltip leaves when the pointer moves away, and a `Escape` that closes the target dropdown leaves no tooltip for the focus that returns to the trigger) and a new detection case (the source list shows `Auto (French)` on its automatic row after a resolved detection, keeps `Auto` while `Detecting` is in flight, and choosing it keeps the automatic source). `app/quick-translate.test.tsx` passed 43/43. Rendered Windows `--target windows` PNG screenshots confirmed the popup-window tooltip (`bg-sidebar-primary`, `rounded-xl`, `text-xs`, flipped below the header capsule because the window edge leaves no room above) and the open source list with the checked `Auto (French)` row. Held frame timing and live Narrator speech remain manual desktop checks. The tooltip is pointer-only by design: it shows the full label whether or not the chip truncates, because NSH reports no text-overflow state.

## Theme Colors
```css
:root {
  --surface-subtle: oklch(0.984 0.002 247.8);
  --surface-control: oklch(1 0 0);
  --brand: oklch(0.546 0.245 262.881);
  --brand-soft: oklch(0.96 0.025 258);
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
  --surface-subtle: oklch(0.205 0 0);
  --surface-control: oklch(0.269 0 0);
  --brand: oklch(0.65 0.2 258);
  --brand-soft: oklch(0.26 0.06 258);
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
