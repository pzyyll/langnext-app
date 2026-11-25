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

| Change | Motion | Reduced motion |
| --- | --- | --- |
| Test Connection, Save, and enable switch press | Shared `pressScale` and switch thumb feedback | No transition or travel |
| Deck, note type, and field menus | Shared `popup` and `popupHidden` tokens | No transition or travel |
| Connection status, field choices, and save result | Replace the status text in place. No layout animation. | Same |

Wordbook has no drag, live updates, or a new route transition.
