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

## Quick Translate Selection Feedback

A selection read that delivers no text explains itself in the source toolbar. An empty selection shows ordinary muted text. An unreadable selection shows an inline alert with a secondary **Screenshot Translate** action that starts the existing region selection; a cancelled region keeps the draft and returns focus to the header Screenshot Translate action. A new attempt, a draft edit, a delivery, recognition, or closing replaces the message.

### Motion Inventory

| Change                                  | Motion                                                                       | Reduced motion         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| Selection feedback appears or clears    | Immediate replacement in the existing status row; no moving status indicator | Same                   |
| Recovery action hover and press         | Shared `pressScale` feedback                                                 | No transition or scale |
| Window content fit after the status row | Unchanged: the existing content fit, which never widens the popup            | Same                   |

The feedback adds no overlay, travel, or live region; it does not move the keyboard focus.
