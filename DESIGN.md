# Langnext Design

## Quick Translate History

The History button opens a recent-action menu in the Quick Translate window. Each item shows one line of source text. Selecting a record restores its original text and shows its saved translations as read-only cards. Editing the text or starting a translation returns to the current presets. The menu scrolls inside the window and does not resize it.

### Motion Inventory

| Change                                          | Motion                                                                                           | Reduced motion          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| History trigger or Copy button hover and press  | Shared `pressScale` feedback                                                                     | No transition or scale  |
| History row hover, focus, and press             | Shared `navigationFeedback` color transition                                                     | Immediate color change  |
| Menu opens or closes                            | Shared `popup` and `popupHidden` tokens                                                          | No transition or travel |
| Loading, empty, and error text; copied glyph    | Immediate replacement; no moving status indicator                                                | Same                    |
| Selected history restores text and result cards | Replace content together and return focus to the source field; use the normal window content fit | Same                    |

History has no drag, live updates, or persistent selection in the menu.

## Wordbook

Settings → Integrations → Wordbook configures one Anki destination. It does not list saved notes, and it has no main sidebar entry.

### Motion Inventory

| Change                                            | Motion                                                                            | Reduced motion          |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------- |
| Test Connection, Save, and enable switch press    | Shared `pressScale` and switch thumb feedback                                     | No transition or travel |
| Deck, note type, and field menus                  | Shared `popup` and `popupHidden` tokens                                           | No transition or travel |
| Connection status, field choices, and save result | Replace the status text in place. No layout animation.                            | Same                    |
| Quick Translate add press and tooltip             | Shared icon `pressScale` and tooltip. The status glyph and text replace in place. | No transition or travel |

Wordbook has no drag, live updates, or a new route transition.

## Quick Translate Selection Feedback

A selection read that delivers no text explains itself in the source toolbar. An empty selection shows ordinary muted text. An unreadable selection shows an inline alert with a secondary **Screenshot Translate** action that starts the existing region selection; a cancelled region keeps the draft and returns focus to the header Screenshot Translate action. A new attempt, a draft edit, a delivery, recognition, or closing replaces the message.

### Motion Inventory

| Change                                  | Motion                                                                       | Reduced motion         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| Selection feedback appears or clears    | Immediate replacement in the existing status row; no moving status indicator | Same                   |
| Recovery action hover and press         | Shared `pressScale` feedback                                                 | No transition or scale |
| Window content fit after the status row | Unchanged: the existing content fit, which never widens the popup            | Same                   |

The feedback adds no overlay, travel, or live region; it does not move the keyboard focus.

## Quick Translate Selection Hint

After the user drags over text, an optional small **Translate Selection** button appears beside the release point. It is an opt-in in **Settings → Application → Shortcuts**, off by default. The button never takes the focus, so the selection stays with the application that owns it, and it reads nothing until it is clicked. It hides after three seconds, on the next press outside it, on activation, when Quick Translate or its screenshot workflow takes over, or when the option is turned off. The **Translate Selection** shortcut remains the keyboard path.

### Motion Inventory

| Change                                | Motion                                                               | Reduced motion         |
| ------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| Hint appears or follows a new release | No opening transition, travel, or fade: it is placed before it opens | Same                   |
| Hint disappears on expiry or a press  | Removed at once; nothing animates and the pointer never chases it    | Same                   |
| Translate Selection press             | Shared `pressScale` feedback                                         | No transition or scale |
| Drag button setting switch            | Shared switch motion                                                 | No transition          |

## Quick Translate Vertical Stream

The Quick Translate popup arranges the source query, engine translation rows, and footer in one continuous edge-to-edge vertical stream separated by hairline borders on a uniform subtle output surface instead of isolated cards.

### Motion Inventory

| Change                                                                   | Motion                                                                                                                                                           | Reduced motion           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Stream row hover wash                                                    | Shared `navigationFeedback` color transition (`150ms` ease-out)                                                                                                  | Immediate color change   |
| Header, toolbar, and action buttons hover and press                      | Shared `pressScale` (`scale-95` on active) and color wash                                                                                                        | No transition or scale   |
| Row hover actions (reorder grip, remove) appear                          | Shared `tooltip` opacity fade (`150ms` ease-out) on row hover or keyboard focus                                                                                  | Immediate opacity change |
| Engine row collapse / expand indicator (`+` ↔ `×`)                       | Shared `disclosureIcon` rotation (`0deg` ↔ `45deg`, `150ms` ease-out); row body and window height fit update immediately so native `fitContentHeight` never lags | Immediate rotation       |
| Engine row drag reorder and release                                      | 1:1 pointer tracking (`cardOffset`) during pan; `180ms` `easeOut` settle on release                                                                              | Instant snap             |
| Language, preset, template, add-preset, and history dropdowns            | Shared `popup` and `popupHidden` reveal and dismiss; Select triggers keep `navigationFeedback`                                                                   | No transition or travel  |
| Streaming translation, loading, error, copy checkmark, and speech toggle | Immediate replacement in place; no pulsing or moving status indicators                                                                                           | Same                     |
| Inline back-translation hover                                            | Shared `navigationFeedback` color transition (`150ms` ease-out)                                                                                                  | Immediate color change   |
| Inline back-translation open, retry, error, and close                    | Immediate mount/unmount in place so window height fit tracks content cleanly; back-translate toggle holds `brand-ghost` `selected` fill                          | Same                     |

## Startup Failure

A start that fails before the app shell mounts shows a window of its own instead of nothing: a heading, the failure message (selectable), the log file path when the app writes one, and **Exit** on the desktops. It keeps the system title bar so it can be moved without the shell's drag row.

### Motion Inventory

| Change                             | Motion                                                               | Reduced motion         |
| ---------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| Startup fails and the window opens | Opens at once, with no entrance animation: the message is the point  | Same                   |
| Exit press                         | Shared `pressScale` feedback; the app quits, so nothing closes after | No transition or scale |
| Failure message and log path       | Static text; it changes only when the app starts again               | Same                   |

The window adds no overlay, travel, live region, drag, or layout animation.

## Quick Translate Sentence Highlight

The same setting aligns the translation and back-translation with the original text. Alignment stays active when the source editor is collapsed. Hover over a matched sentence or use `Left`/`Right` in its preview to highlight the sentence. If the source editor is expanded, it highlights the matching original sentence. Only the active output shows a highlight.

Click a matched sentence or press `Enter`/`Space` in its preview to open the anchored popover with the original sentence. The highlight stays active while the popover is open. Selecting another sentence updates the popover. Click the active sentence again, click outside, or press `Escape` to close it. Scrolling, changing the source or Markdown mode, retrying the active output, closing the back-translation, or hiding the window also closes it.

| Surface                                                     | Gesture / Trigger                                                                | Motion                                                                                            | Reduced Motion          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- |
| Translation or back-translation sentence and original range | Pointer hover, click hold, keyboard `Left`/`Right`, accessibility `Prev`/`Next`  | Immediate `bg-brand-soft` toggle; no scroll, focus move, or caret change                          | Same immediate toggle   |
| Source sentence popover                                     | Sentence click, keyboard `Enter`/`Space`, accessibility `Show original`, dismiss | Shared `popupEnter` (`150ms` `easeOut`, opacity `0 → 1`, translateY `-4pt → 0`); updates in place | Instant open, no travel |

The highlight itself adds no live region or layout animation.

The Sentence alignment switch is in Settings → Application → Quick Translate. A separate Semantic model row below it displays **Multilingual E5 Small** and owns manual **Download**, **Cancel**, **Retry**, progress, and the **Downloaded** badge. Turning **Sentence alignment** on without an installed model opens a confirmation dialog (**Cancel** and **Download and enable**) before any transfer starts. There is no download control in the floating window.

| Surface                        | Change                                                                                | Motion                                                                                                                  | Reduced Motion               |
| ------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Settings switch and info       | Toggle, disabled while downloading, focus, hover                                      | Shared `navigationFeedback`, `switchThumb`, focus ring, and `tooltip` (`150ms` ease-out)                                | Immediate change (`0ms`)     |
| Semantic model row and actions | Hover and press on **Download**, **Cancel**, and **Retry**; **Downloaded** badge swap | Shared `pressScale` (`150ms` ease-out, `active:scale-95`); badge and controls replace in place without layout animation | No transition or scale       |
| Model transfer status          | Progress percentage, **Turns on after download** hint, download/load/save alerts      | `Progress` indicator follows actual transfer percentage; hints and alerts replace in place with no pulse or travel      | Same                         |
| Download confirmation dialog   | Open, button hover/press, **Cancel**, **Download and enable**, Escape, backdrop press | Shared `dialogAnimation` (`fade`), `pressScale` on buttons, focus moves inside dialog and returns on dismiss            | Instant open/close, no scale |
| Quick Translate result         | Turn alignment on or off                                                              | Preview appears or clears immediately without replaying translation                                                     | Same                         |

## Quick Translate OCR Recognition

While OCR recognizes a captured region, an empty source field displays two staggered skeleton lines over the disabled editor so the input area never reads as a blank void, paired with a pulsing recognition mark in the bottom-left source status row and an active brand state on the header OCR button. When an existing draft is already present, the dimmed draft stays visible without skeleton bars.

### Motion Inventory

| Surface               | Change                                               | Motion                                                                                        | Reduced Motion               |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| Empty source skeleton | Appears while recognizing with an empty source field | Two staggered `Skeleton` bars pulse opacity (`0.45` ↔ `1`, `1300ms` `easeInOut`, `180ms` lag) | Static bars at `0.7` opacity |
| Source OCR status row | Recognition mark (`mdi:text-recognition`) active     | Opacity pulses (`0.45` ↔ `1`, `1300ms` `easeInOut`); text stays steady                        | Static mark at `1` opacity   |
| Header OCR button     | Enters and leaves `"recognizing"` phase              | Shared `brand-ghost` selected fill and brand icon tone swap                                   | Immediate color swap         |
| Recognition completes | Text arrives, errors, or returns to idle             | Skeleton and status row unmount immediately in place; recognized text replaces cleanly        | Same                         |
