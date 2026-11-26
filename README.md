# Langnext

[中文](README.zh-CN.md)

Langnext is a desktop application for translation. You can type text, translate a selection, or translate text in a screenshot. One Quick Translate window can show several translations of the same text.

## Prepare a translation

1. Open **Models** and add a model channel.
2. Open **Presets** and add a preset. A preset can use **AI Translation**, **DeepL API**, or **Google Cloud Translation**.
3. Enable the presets that you want to use.

Quick Translate uses enabled presets only.

## The main window

- **Settings → General → Language** sets the interface language to **System**, **English**, or **简体中文**.
- **Settings → Appearance** sets **Light**, **Dark**, or **System**. Langnext keeps this choice after you close it.

## Quick Translate

Quick Translate is a small window. You can open it when the main window is hidden.

Open it from the system tray menu (**Quick Translate**), or with a Windows shortcut.

| Action | Default | Result |
| --- | --- | --- |
| Open Quick Translate | `Alt+Shift+D` | Opens or focuses Quick Translate. |
| Screenshot Translate | `Alt+S` | You select a screen region. Langnext reads the text and translates it. |
| Translate Selection | `Alt+D` | Langnext reads the selected text and translates it. |

Change a shortcut in **Settings → Application → Shortcuts**:

1. Select **Edit** and press the new key combination.
2. Select **Clear** to remove the shortcut.
3. Select **Reset** to restore the default when the current shortcut is different.

These shortcuts work on Windows. If a saved shortcut is not available when Langnext starts, Langnext warns you. The tray menu still opens Quick Translate. If a new shortcut cannot be saved, the previous shortcut stays active.

`Alt+D` can also focus the address bar in Edge or File Explorer. If **Open Quick Translate** or **Screenshot Translate** already uses `Alt+D`, that action keeps the key. **Translate Selection** stays inactive until you record a free combination. **Reset** tries `Alt+D` again. If the key is still in use, the saved shortcut stays.

### Selection

**Translate Selection** reads the selection with Windows UI Automation first. It does not use OCR.

**Simulate Copy to Get Text** is off by default. Turn it on in **Settings → Application → Shortcuts** when a control does not expose the selection. Langnext then tries `Ctrl+C`. This can replace the clipboard contents. Langnext does not translate a whole-line copy from VS Code when nothing is selected.

These results were checked on Windows:

| Application | Result |
| --- | --- |
| Notepad, Word, and Chrome search results | UI Automation returned the selection. |
| VS Code 1.146.0 | The selected editor text was returned when **Simulate Copy to Get Text** was on. |
| One X page, Adobe Acrobat PDF, and Windows Terminal | UI Automation did not return the text. |

Results can change with the page and the application version.

A password field, a missing selection, or a control that Langnext cannot read still opens Quick Translate and keeps the current draft. An empty selection shows that no text is selected. If the selection cannot be read, an alert offers **Screenshot Translate**. If you cancel the region selection, the draft stays.

### Drag button

**Show Translate Button After Dragging Text** is off by default. Turn it on in **Settings → Application → Shortcuts**. After you drag over text, a **Translate Selection** button appears beside the pointer. The button reads nothing until you click it. The click uses UI Automation only and does not send `Ctrl+C`.

The button hides after three seconds, on the next press outside it, when you use it, or when Quick Translate opens. The **Translate Selection** shortcut stays available.

### Double-copy

**Double-copy Quick Translate (`Ctrl+C × 2`)** is off by default. The shortcut is fixed. Turn it on or off in **Settings → Application → Shortcuts**. Two quick `Ctrl+C` presses open Quick Translate and translate the copied text with your enabled presets.

### Cards and languages

The cards share one source text and one language pair. Each card uses one preset and one prompt template.

- Drag a card header to change the order. You can also focus its grip and press the up or down arrow key.
- Select the header, away from the controls on it, to collapse or expand the card.
- Langnext saves the card order.

Set the source language and the target language in the title-bar language menu. **Auto** uses language detection. See [Language detection](#language-detection).

**Auto-translate** is off by default. When it is on, Langnext waits 500 ms after you stop changing the text, then translates. Copied text is translated when the window shows it, even when **Auto-translate** is off. Press **Enter** to translate. Press **Shift+Enter** to insert a new line.

On a result card you can copy the text, show Markdown or plain text, read the text aloud, and request a back-translation. Reading aloud needs a channel in **Settings → Integrations → Text-to-Speech**.

### Screenshot text

**Screenshot Translate** works on Windows. Configure OCR in **Settings → Integrations → OCR** before you capture a region. You can add **LLM**, **Baidu OCR**, or **Google Cloud Vision**. Enabled channels run from top to bottom. Later channels are backups.

Select a screen region. Langnext reads the text and translates it with the enabled presets. You can also start this action from the tray menu.

### Sentence alignment

Sentence alignment is available on Windows. It matches a translated sentence to its source sentence. Alignment runs on this computer and does not send the text to another service. The translation request still sends the full text to the provider that you selected.

1. Open **Settings → Application → Quick Translate**.
2. Download **Multilingual E5 Small** (about 135 MB), or turn on **Sentence alignment**. If the model is missing, Langnext asks you to confirm the download. It waits until the files are checked and the model loads.
3. Select **Cancel** on the model row to stop a download. You can select **Download** while alignment stays off.

When alignment is on and the source text is expanded, point at a translated sentence to see its source sentence. You can also focus a result and press the left or right arrow key to move through the matched sentences.

This works for plain text and for Markdown prose. It does not change the copied text, and it skips non-prose Markdown blocks. The highlight clears when you edit the text, change the selection, scroll, collapse the card, or hide the window.

Turn **Sentence alignment** off to clear open highlights. The installed model stays. Langnext does not change the translations and does not send the text again.

### History

Langnext keeps the source text and the successful results of the last 30 translation actions. Open **History** to restore a saved result. A restore does not request a new translation. The database stays on this computer and is not encrypted.

Langnext does not keep drafts, errors, or keystrokes in history.

## Wordbook

Wordbook saves one Quick Translate result to a local Anki deck. It stays off until you save a destination and turn it on. Langnext does not turn Wordbook on by itself.

1. Install the AnkiConnect add-on in Anki Desktop. Its code is `2055492159`.
2. Keep Anki Desktop open, with a profile and a normal deck.
3. Open **Settings → Integrations → Wordbook**.
4. Enter an API key only when AnkiConnect requires one. A saved key stays on this computer and is not encrypted.
5. Select **Test connection**. Choose the deck, the note type, and the translation field. The first field of the note type is the source field.
6. Select **Save**, then turn on **Enable Anki**.

Langnext sends Anki requests only to `http://127.0.0.1:8765`. On a finished forward translation, select **Add to Anki**. That action sends the source text and the translation from that card. It does not send history, a back-translation, or another card. If that source already exists in the chosen deck and note type, Anki does not change it.

Langnext does not state support for one Anki version, one AnkiConnect version, or one desktop target.

## Language detection

Language detection resolves **Auto** to a specific language before translation. Enabled detectors run from top to bottom. Later detectors are backups. There is no detector on this computer.

1. Open **Settings → Integrations → Language Detection**.
2. Select **Add Channel**.
3. Add **LLM** and select a model, add **Google**, or add **Google Cloud** and save an API key. **Google** needs no key and is enabled when you add it.
4. Set **Native language** and **Target language**.

Detection stays off until you add a detector and enable it.

- **LLM** sends a sample to one text model. An unusable answer falls through to the next enabled detector.
- **Google** uses the free Google Translate endpoint.
- **Google Cloud** calls Cloud Translation with your API key and bills that project. A blank key field keeps the saved key.

Drag a detector grip to change the order, or focus the grip and press the up or down arrow key. The first enabled detector is the primary detector.

With an **Auto** target, text in another language is translated into your native language. Text in your native language is translated into the **Target language**. A specific source and a specific target do not start detection.

With no enabled detector, an **Auto** source needs a source that you choose. An **Auto** target needs a native language.

Quick Translate detects an **Auto** source once for one input. Reading the source aloud uses that same detection when it has not run yet. Later translations of that input reuse the answer, including when you expand a card or retry. An edit, or a change to the detector order, starts a new detection. A failed detection is not reused.

A blocked or failed detection does not guess the language. The card, or the reading error, asks you to choose the source language. Cancellation stays silent.

Each detector that runs receives the first 2,048 characters of the trimmed text. That service can be different from the translation preset. The full source text still goes to the translation service. Langnext does not store or log the sample, the detected language, or the model reply.

## Logs

Open **Settings → General → Logs** and select **Open folder**.

On Windows, the log file is `%APPDATA%\com.dev.langnext\logs\app.log`. The file rolls over at 5 MiB. Langnext keeps three older files, `app.1.log` through `app.3.log`.

**Settings → General → Log level** sets the lowest level that Langnext writes: **Error**, **Warning**, or **Info**. The default is **Warning**. This setting does not include `debug` lines.

## Privacy

- Provider keys stay on this computer.
- A translation sends the source text to the services for the enabled preset cards.
- Language detection sends text only when a translation or a reading needs an automatic source, and only once for that input.
- Sentence alignment stays on this computer.
- Langnext does not log source text, translated text, or API keys.

## Build from source

See [Development](docs/development.md).
