# Design System

## Page layout

Every page owns scrolling: its root is `Scroll class="min-w-0 flex-1"`. Its content is one column with a
shared leading edge: `class="w-full max-w-4xl gap-8 p-8"`. A page does not set its own content width or
padding, so switching destinations never moves the leading edge.

`class` carries static layout and appearance. `style` is for values computed at run time only: platform
metrics (`titleBar()` in the shell's title bar) and theme colors (`token()` in the sidebar). Static spacing,
sizes and colors belong in classes; a value with no class-scale step gets an arbitrary class
(`max-w-[824px]`), not a `style`.

## Home navigation

The desktop shell opens Home by default. The sidebar groups destinations by
position: the M and Models buttons sit at the top, the Settings button at the
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

Home contains a static translation example, not a connected translation service.
It uses the existing text scale, spacing, surfaces, and semantic theme colors.
The page owns scrolling. Its content uses one shared leading edge and wraps at
the minimum window width.

### Motion inventory

| Change | Tool and tokens | Reduced motion |
| --- | --- | --- |
| Navigation hover and press | Native color transition; `navigationFeedback`, 150 ms, ease-out; press deepens the fill | Instant |
| Current destination | Selected fill follows the current page with the same transition. No sliding marker: the two destinations sit at opposite ends of the sidebar. | Instant |
| Home or Settings enters | Native opacity motion; `pageEnter`, 200 ms, ease-out. No directional slide between sibling pages. | Instant |
| Navigation tooltip opens or closes | Native opacity transition; `navigationFeedback`, 150 ms, ease-out | Instant |
| Labels, user-controlled layout, gestures, loading, live content | None. Home is static example content. | No change |

Motion tokens are defined in `components/motion.ts`. Settings controls retain
their existing behavior and appearance.

### Validation

- Radius, typography, spacing, alignment, and theme colors: reviewed in Windows
  screenshots, in light and dark, at 1040 × 720 and 720 × 520. No clipping found.
- Hover and selection: reviewed both destinations and their tooltips.
  Selected controls keep a readable foreground during hover.
- Pressed state: uses a stronger fill. Pointer cancellation was not tested.
- Shared components and standards: both destinations use `SidebarItem`. Both
  pages use `PageSurface`. Existing Settings controls remain unchanged.
- Other states: selection and tooltip dismissal pass native tests. Home has no
  disabled controls, loading, error, or dynamic content.
- Motion: page entry, selection feedback, and tooltips run natively. Reduced-motion
  navigation passes tests. Frame-by-frame motion was not reviewed. No sound is used.
- Accessibility: role/name selectors pass Windows tests. Screen-reader behavior
  and Tab focus were not verified.
- Platforms and content: Windows only. Large text, other desktop platforms, and
  right-to-left layout remain manual checks. Mobile and TUI are outside scope.

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
