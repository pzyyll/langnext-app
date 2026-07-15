# Quick Translate Popup — Implementation Plan

Reference: `langnext-translate` translate popup logic. Target: `langnext-app` Quick Translate window.

## Goal

Make the Quick Translate window behave like `langnext-translate`'s translate popup:

1. **Click-outside auto-close** — clicking outside the window hides it; a **Pin** button disables this.
2. **Double Ctrl+C** — opens the window at the mouse cursor, clamped to the active monitor's bounds (multi-monitor aware), and **auto-pastes clipboard content** into the source box to trigger translation.

## Reference source (langnext-translate)

The authoritative implementation lives in `F:\workspace\my\langnext-translate\src-tauri\src\windows\translate.rs`. Key mechanisms (verified):

- **Click-outside close**: global low-level mouse hook via `kmhook::enginer::add_event_listener` with `EventType::MouseEvent`. On left-click outside the window rect -> `window.close()`. On mouse-move outside (when not yet focused inside and not pinned) -> `window.close()`. An `AtomicBool once_focus` records that the user clicked inside once, after which move-out no longer closes (but click-outside still does). `CloseRequested` is intercepted to `hide()` + `del_mouse_event()`.
- **Pin**: `TWinState { is_pin: Mutex<bool> }` managed on the window; `set_pin` command flips it; the mouse-hook callback returns early when `is_pin` is true. `show()` resets pin to false on (re)creation.
- **Double Ctrl+C**: `kmhook::enginer::add_global_shortcut_trigger("Ctrl+C", cb, 2, Some(400))` — `hit_times=2` means two presses within 400ms; a single Ctrl+C still copies (hook is non-consuming).
- **Cursor follow**: `app.cursor_position()` (needs Tauri `unstable` feature) → converted to logical coords via the monitor's `scale_factor()` → `WebviewWindowBuilder::position(x, y)`. On re-show, `adjust_win_position(win, Some(cursor))`.
- **Boundary clamp**: `adjust_win_position` uses `app.monitor_from_point(x, y)` to get the monitor, then shifts the window left/up if it overflows the monitor's right/bottom edge. (langnext-translate only clamps right/bottom; this plan also clamps left/top.)
- **Multi-monitor**: `monitor_from_point` returns the monitor under the cursor (Windows `MonitorFromPoint` underneath).
- **Auto-paste**: `try_show_on_cpcp(app)` → ensure window visible → `emit_on_cpcp(win)` reads `app.clipboard().read_text()` and `win.emit_to(webview_window(label), "cpcp", text)`. On first creation it waits for `on_page_load(Finished)` before emitting. Frontend `listen`s and sets the source text, which the existing debounce auto-translate picks up.

## Dependency changes

### `src-tauri/Cargo.toml`

1. Add `unstable` to the `tauri` features (required by `AppHandle::cursor_position()`; `monitor_from_point` is stable since 2.0.0-beta.20 but is covered by the same feature group):

```toml
tauri = { version = "2", features = ["tray-icon", "image-ico", "image-png", "unstable"] }
```

2. Add the clipboard plugin to the desktop-only target block (alongside `tauri-plugin-global-shortcut`):

```toml
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
tauri-plugin-global-shortcut = "2"
tauri-plugin-clipboard-manager = "2"
```

> `kmhook` already exists in the `cfg(windows)` block — reuse it for the mouse hook.

## Backend (Rust)

### `src-tauri/src/consts.rs`

Add a clipboard-paste event name (frontend mirrors this string):

```rust
/// Event carrying clipboard text to the Quick Translate window on double Ctrl+C.
pub const QUICK_TRANSLATE_CLIPBOARD_EVENT: &str = "quick-translate://clipboard-text";
```

### Pin state

Define a managed state (place it in `src-tauri/src/windows/quick_translate.rs` and manage it app-level in `app_setup`). App-level is fine because there is exactly one Quick Translate window.

```rust
use std::sync::Mutex;

#[derive(Debug, Default)]
pub struct QuickTranslateState {
    pub is_pin: Mutex<bool>,
}

impl QuickTranslateState {
    pub fn reset(&self) {
        *self.is_pin.lock().unwrap() = false;
    }
}
```

### `set_pin` command (in `quick_translate.rs`)

```rust
#[tauri::command]
pub async fn set_pin<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, QuickTranslateState>,
    is_pin: bool,
) -> Result<(), String> {
    *state.is_pin.lock().unwrap() = is_pin;
    // Keep always-on-top in sync so a pinned window stays above while editing elsewhere.
    if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
        let _ = win.set_always_on_top(true);
    }
    Ok(())
}
```

Register it in `lib.rs` `invoke_handler!` and `app.manage(QuickTranslateState::default())` in `app_setup`.

### Clipboard plugin registration (`lib.rs`)

Add to the `tauri::Builder::default()` chain:

```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

and `use tauri_plugin_clipboard_manager::ClipboardExt;` where reading the clipboard.

### Rewrite `src-tauri/src/windows/quick_translate.rs`

Mirror `langnext-translate`'s `translate.rs`. Concretely:

**Imports**

```rust
use crate::consts;
use kmhook::enginer as mouse_enginer;
use kmhook::types::{ClickState, EventType, MouseButton, Pos};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use tauri::{
    Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, Pixel, Runtime, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
```

**Statics**

```rust
static MOUSE_EVENT_ID: AtomicUsize = AtomicUsize::new(0);
// Latest known outer size in physical px; updated on Resized/positioned.
// Use a Mutex<(f64,f64)> like langnext-translate, or read win.outer_size() live.
```

**`adjust_win_position`** — clamp the window so it stays fully inside the monitor under the cursor. Improve on langnext-translate by also clamping left/top:

```rust
fn adjust_win_position<R: Runtime, P: Pixel>(
    win: &WebviewWindow<R>,
    cursor: Option<PhysicalPosition<P>>,
) {
    // 1. resolve a physical cursor position (provided or window outer_position)
    // 2. win.app_handle().monitor_from_point(x, y) -> monitor
    // 3. monitor bounds: min = position(), max = position + size
    // 4. win size = win.outer_size() (or cached WIN_SIZE)
    // 5. clamp: x in [min.x, max.x - win_w], y in [min.y, max.y - win_h]
    // 6. win.set_position(PhysicalPosition::new(x, y))
}
```

All coordinates in **physical** space here. Note the monitor's `position()`/`size()` are physical; `outer_size()` is physical.

**`check_pos_in_window`** — point-in-rect test using `outer_position()` + `outer_size()`.

**`reg_mouse_event(window: Arc<WebviewWindow>)`** — register the kmhook listener (skip if `MOUSE_EVENT_ID != 0`). Logic (identical to langnext-translate):

- `EventType::MouseEvent(Some(event))`
- Left button `Pressed` (ignore `Released`):
  - if `is_pin` → return
  - if point in window → set `once_focus = true`, return
  - else → `window.close()`
- `event.button.is_none()` (mouse move):
  - if point in window **or** `is_pin` **or** `once_focus` → return
  - else → `window.close()`
- Store the returned id in `MOUSE_EVENT_ID`.

**`del_mouse_event()`** — if id != 0, `mouse_enginer::del_event_by_id(id)`, reset to 0.

**`emit_on_cpcp(win)`**

```rust
fn emit_on_cpcp<R: Runtime>(win: &WebviewWindow<R>) {
    if let Ok(text) = win.app_handle().clipboard().read_text() {
        let _ = win.emit_to(
            EventTarget::webview_window(consts::WIN_LABEL_QUICK_TRANSLATE),
            consts::QUICK_TRANSLATE_CLIPBOARD_EVENT,
            text,
        );
    }
}
```

**`set_win_visible(app, win)`** (re-show existing hidden window):

```rust
fn set_win_visible<R: Runtime>(app: &tauri::AppHandle<R>, win: &WebviewWindow<R>) {
    if let Ok(cursor) = app.cursor_position() {
        adjust_win_position(win, Some(cursor));
    }
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    let _ = win.set_focus();
    reg_mouse_event(Arc::new(win.clone()));
}
```

**`try_show_on_cpcp(app)`** — the double Ctrl+C entry point:

```rust
pub fn try_show_on_cpcp<R: Runtime>(app: &tauri::AppHandle<R>) {
    match app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
        Some(win) => {
            if let Ok(visible) = win.is_visible() {
                if !visible {
                    set_win_visible(app, &win);
                }
            }
            emit_on_cpcp(&win);
        }
        None => {
            // create, then emit once the page is loaded
            match show(app) {
                Ok(win) => {
                    let app = app.clone();
                    win.once("tauri://page-load-finished" /* or a custom on_ready */, move |_| {
                        if let Some(win) = app.get_webview_window(consts::WIN_LABEL_QUICK_TRANSLATE) {
                            emit_on_cpcp(&win);
                        }
                    });
                }
                Err(e) => log::error!("quick_translate_show_failed error={e}"),
            }
        }
    }
}
```

> langnext-translate uses a custom `"on_ready"` event emitted from `on_page_load(Finished)`. In Tauri 2 you can either emit a custom event from the `on_page_load` callback, or use the built-in `tauri://page-load-finished`. Pick one and be consistent; emitting a custom `"qt://ready"` from `on_page_load(Finished)` is the most reliable.

**`show(app)`** — rewrite to position at the cursor instead of `.center()`:

- `cursor = app.cursor_position()?` (physical)
- monitor = `app.monitor_from_point(cursor.x, cursor.y)?`; scale = `monitor.scale_factor()`; logical cursor = `cursor.to_logical::<f64>(scale)`
- builder: drop `.center()`, add `.position(logical_x, logical_y)`
- keep: `decorations(false)` (windows), `resizable`, `always_on_top(true)`, `inner_size(600,640)`, `min_inner_size(420,480)`, `disable_drag_drop_handler()`, `visible(true)`, context-menu disabling
- `.on_page_load(|w, payload| if Finished { record size; adjust_win_position(w, None); emit "qt://ready" })`
- after build: reset/manage `QuickTranslateState`; `wire_window_events(&win)`; `reg_mouse_event(Arc::new(win.clone()))`; `set_focus()`

**`wire_window_events`** (replaces `wire_close_to_hide`):

```rust
fn wire_window_events<R: Runtime>(window: &WebviewWindow<R>) {
    let win = Arc::new(window.clone());
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            del_mouse_event();
            let _ = win.hide();
        }
        tauri::WindowEvent::Destroyed => {
            del_mouse_event();
        }
        tauri::WindowEvent::Resized(_) => {
            // update cached WIN_SIZE if you cache it
        }
        #[cfg(not(windows))]
        tauri::WindowEvent::Focused(false) => {
            // Non-Windows fallback for click-outside close (no kmhook available).
            // Skip if pinned.
            let app = win.app_handle();
            if let Some(state) = app.try_state::<QuickTranslateState>() {
                if *state.is_pin.lock().unwrap() { return; }
            }
            let _ = win.hide();
        }
        _ => {}
    });
}
```

> The Windows path relies on the kmhook mouse hook for click-outside (so it works even without focus). Other platforms fall back to `Focused(false)`. Keep the `#[cfg]` split.

### `src-tauri/src/lib.rs`

- `app_setup`: `app.manage(windows::quick_translate::QuickTranslateState::default());`
- double Ctrl+C callback: replace `windows::quick_translate::show(&app_handle)` with `windows::quick_translate::try_show_on_cpcp(&app_handle)`.
- `invoke_handler!`: add `windows::quick_translate::set_pin`.
- Builder chain: add `.plugin(tauri_plugin_clipboard_manager::init())`.
- `ctrl+shift+t` handler can stay as `show()` (no auto-paste) — out of scope for this change, but acceptable to also route through `try_show_on_cpcp` if you want paste-on-open there too. Default: leave as `show()`.

## Frontend (React)

### `src/routes/quick-translate.tsx`

1. Import the event listener:

```tsx
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
```

2. Add a `useEffect` that subscribes to the clipboard-paste event and sets the source text (the existing debounce at line ~418 will auto-translate):

```tsx
useEffect(() => {
	let unlisten: (() => void) | undefined;
	let cancelled = false;
	void listen<string>("quick-translate://clipboard-text", (event) => {
		if (cancelled) return;
		setSourceText(event.payload ?? "");
	}).then((fn) => {
		unlisten = fn;
	});
	return () => {
		cancelled = true;
		unlisten?.();
	};
}, []);
```

> Mirrors the event name in `consts.rs`. Always overwrite — double Ctrl+C means "translate the clipboard now".

3. Add Pin state + handler:

```tsx
const [isPinned, setIsPinned] = useState(false);
const togglePin = useCallback(() => {
	setIsPinned((prev) => {
		const next = !prev;
		void invoke("set_pin", { isPin: next });
		return next;
	});
}, []);
```

4. Pass to `TitleBar`:

```tsx
<TitleBar
	title={t("quickTranslate.title")}
	minimize={false}
	maximized={false}
	close
	pin
	pinned={isPinned}
	onPinChange={togglePin}
	leading={<Menu.Root>...</Menu.Root>}
/>
```

### `src/components/Win/TitleBar.tsx`

Add optional Pin support that does **not** affect the main window (main window simply doesn't pass `pin`):

- New props: `pin?: boolean`, `pinned?: boolean`, `onPinChange?: (pinned: boolean) => void`.
- Render a pin button as the **first** control in the right control group (before `minimize`), only when `pin` is true.
- Use the same `controlButtonClassName` style; when `pinned`, apply an active look (e.g. `bg-surface-3` / a tinted text color).
- Icon: an Iconify pin icon via `unplugin-icons`, e.g. `~icons/material-symbols-light/push-pin` (pinned) and an outlined variant (unpinned). Pick one collection already installed; add a collection only if needed.
- `aria-label={pinned ? t("quickTranslate.unpin") : t("quickTranslate.pin")}`, `aria-pressed={pinned}`.

### i18n

Add to both `src/i18n/locales/en.ts` and `zh-CN.ts` under `quickTranslate`:

```ts
pin: "Pin",      // zh: "固定"
unpin: "Unpin",  // zh: "取消固定"
```

## Validation

1. `mise run typecheck` — Rust + TS must pass.
2. `mise run lint` — ESLint clean.
3. `mise run format:check` (or `mise run format`) — Prettier + cargo fmt.
4. `mise run tauri:dev` — manual checks:
   - Double Ctrl+C opens the window at the cursor; clipboard text appears and auto-translates.
   - Move window near a screen edge / onto a second monitor before triggering — window stays fully visible.
   - Click outside → window hides. Click inside first, then move out → stays (once_focus).
   - Pin → click outside / move out no longer hides. Unpin → resumes.
   - Single Ctrl+C still copies normally (no interference).
   - Close button hides (not destroys); next open is instant and re-positions to cursor.

## Conventions (AGENTS.md)

- Every new/changed Rust file keeps a 2-line `// ABOUTME:` header.
- Use Base UI primitives where applicable (the Pin button can reuse the existing native `<button>` pattern already in `TitleBar` for control buttons — match surrounding style).
- Prefer named Tailwind tokens; container scale for widths.
- Icons via `unplugin-icons`; no inline `<svg>`.
- Do not add `package.json` scripts; tasks live under `.mise/tasks/`.
- Do not use `new`/`improved`/`enhanced` in names.
- Match existing tab indentation in Rust files; run `mise run format` after edits.

## Notes / trade-offs

- `cursor_position()` requires the `unstable` Tauri feature — this is the same as langnext-translate and is safe.
- The kmhook mouse hook is Windows-only; macOS/Linux fall back to `Focused(false)` for click-outside. Double Ctrl+C itself is already `#[cfg(windows)]`.
- Pin is app-level state (single Quick Translate window). Reset to false whenever the window is (re)created.
- `adjust_win_position` clamps all four edges (improvement over langnext-translate's right/bottom-only clamp) so the window never leaves the screen on the left/top either.
