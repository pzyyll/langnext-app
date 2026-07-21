// ABOUTME: Runtime registration for global open-Quick-Translate, screenshot, OCR, and double Ctrl+C.
// ABOUTME: Applies settings bindings, gates kmhook, and validates rebindable shortcuts.
use crate::consts::{
  DEFAULT_OPEN_QUICK_TRANSLATE_BINDING, DEFAULT_REGION_SCREENSHOT_BINDING, DEFAULT_SCREENSHOT_OCR_BINDING,
  SHORTCUT_DOUBLE_CTRL_C, SHORTCUT_OPEN_QUICK_TRANSLATE, SHORTCUT_REGION_SCREENSHOT, SHORTCUT_SCREENSHOT_OCR,
};
use crate::domain::settings::{ShortcutDefinition, normalize_shortcuts};
use crate::windows;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};

/// App-managed shortcut runtime flags and last-registered bindings.
#[derive(Debug, Default)]
pub struct ShortcutRuntime {
  /// Currently registered open-Quick-Translate binding, if any.
  registered_open: Mutex<Option<String>>,
  /// Currently registered region-screenshot binding, if any.
  registered_region_screenshot: Mutex<Option<String>>,
  /// Currently registered screenshot-OCR binding, if any.
  registered_screenshot_ocr: Mutex<Option<String>>,
  /// When false, the double Ctrl+C kmhook callback is a no-op.
  double_ctrl_c_enabled: AtomicBool,
}

impl ShortcutRuntime {
  pub fn new() -> Self {
    Self {
      registered_open: Mutex::new(None),
      registered_region_screenshot: Mutex::new(None),
      registered_screenshot_ocr: Mutex::new(None),
      // Default on until settings are applied at startup.
      double_ctrl_c_enabled: AtomicBool::new(true),
    }
  }

  pub fn is_double_ctrl_c_enabled(&self) -> bool {
    self.double_ctrl_c_enabled.load(Ordering::SeqCst)
  }

  /// Apply normalized shortcut settings to OS registration and runtime gates.
  ///
  /// Registration failures are logged and returned so callers can surface them;
  /// partial apply is avoided by validating rebindable bindings first.
  pub fn apply<R: Runtime>(&self, app: &AppHandle<R>, shortcuts: &[ShortcutDefinition]) -> Result<(), String> {
    let normalized = normalize_shortcuts(shortcuts.to_vec());
    let open = normalized
      .iter()
      .find(|s| s.id == SHORTCUT_OPEN_QUICK_TRANSLATE)
      .cloned()
      .unwrap_or_else(|| ShortcutDefinition {
        id: SHORTCUT_OPEN_QUICK_TRANSLATE.into(),
        binding: DEFAULT_OPEN_QUICK_TRANSLATE_BINDING.into(),
        enabled: true,
      });
    let region_screenshot = normalized
      .iter()
      .find(|s| s.id == SHORTCUT_REGION_SCREENSHOT)
      .cloned()
      .unwrap_or_else(|| ShortcutDefinition {
        id: SHORTCUT_REGION_SCREENSHOT.into(),
        binding: DEFAULT_REGION_SCREENSHOT_BINDING.into(),
        enabled: true,
      });
    let screenshot_ocr = normalized
      .iter()
      .find(|s| s.id == SHORTCUT_SCREENSHOT_OCR)
      .cloned()
      .unwrap_or_else(|| ShortcutDefinition {
        id: SHORTCUT_SCREENSHOT_OCR.into(),
        binding: DEFAULT_SCREENSHOT_OCR_BINDING.into(),
        enabled: true,
      });
    let double_enabled = normalized
      .iter()
      .find(|s| s.id == SHORTCUT_DOUBLE_CTRL_C)
      .map(|s| s.enabled)
      .unwrap_or(true);

    validate_shortcuts(&normalized)?;

    self.double_ctrl_c_enabled.store(double_enabled, Ordering::SeqCst);

    #[cfg(desktop)]
    {
      // Unregister all first so binding swaps cannot collide mid-apply.
      self.unregister_tracked(app, &self.registered_open)?;
      self.unregister_tracked(app, &self.registered_region_screenshot)?;
      self.unregister_tracked(app, &self.registered_screenshot_ocr)?;
      self.register_open_shortcut(app, open.enabled.then_some(open.binding.as_str()))?;
      self.register_region_screenshot_shortcut(
        app,
        region_screenshot.enabled.then_some(region_screenshot.binding.as_str()),
      )?;
      self.register_screenshot_ocr_shortcut(app, screenshot_ocr.enabled.then_some(screenshot_ocr.binding.as_str()))?;
    }

    #[cfg(not(desktop))]
    {
      let _ = app;
      let _ = open;
      let _ = region_screenshot;
      let _ = screenshot_ocr;
    }

    Ok(())
  }

  #[cfg(desktop)]
  fn unregister_tracked<R: Runtime>(&self, app: &AppHandle<R>, slot: &Mutex<Option<String>>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();
    let mut registered = slot.lock().map_err(|_| "shortcut runtime lock poisoned".to_string())?;
    if let Some(prev) = registered.take() {
      if let Err(err) = gs.unregister(prev.as_str()) {
        log::warn!("global_shortcut_unregister_failed binding={prev} error={err}");
      }
    }
    Ok(())
  }

  #[cfg(desktop)]
  fn register_open_shortcut<R: Runtime>(&self, app: &AppHandle<R>, next_binding: Option<&str>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let Some(binding) = next_binding else {
      return Ok(());
    };

    let gs = app.global_shortcut();
    gs.on_shortcut(binding, |app, _shortcut, event| {
      if event.state == ShortcutState::Pressed {
        if let Err(e) = windows::quick_translate::show(app) {
          log::error!("quick_translate_show_failed error={e}");
        }
      }
    })
    .map_err(|err| format!("failed to register shortcut '{binding}': {err}"))?;

    let mut registered = self
      .registered_open
      .lock()
      .map_err(|_| "shortcut runtime lock poisoned".to_string())?;
    *registered = Some(binding.to_string());
    log::info!("global_shortcut_registered id={SHORTCUT_OPEN_QUICK_TRANSLATE} binding={binding}");
    Ok(())
  }

  #[cfg(desktop)]
  fn register_region_screenshot_shortcut<R: Runtime>(
    &self,
    app: &AppHandle<R>,
    next_binding: Option<&str>,
  ) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let Some(binding) = next_binding else {
      return Ok(());
    };

    let gs = app.global_shortcut();
    gs.on_shortcut(binding, |app, _shortcut, event| {
      if event.state == ShortcutState::Pressed {
        // The plugin holds its shortcut-map mutex while invoking callbacks.
        // screenshot::start registers temporary Escape, so defer until this callback returns
        // or the nested registration deadlocks the entire Tauri event loop.
        let app = app.clone();
        std::thread::spawn(move || {
          if let Err(e) = windows::screenshot::start(&app) {
            log::error!("region_screenshot_start_failed error={e}");
          }
        });
      }
    })
    .map_err(|err| format!("failed to register shortcut '{binding}': {err}"))?;

    let mut registered = self
      .registered_region_screenshot
      .lock()
      .map_err(|_| "shortcut runtime lock poisoned".to_string())?;
    *registered = Some(binding.to_string());
    log::info!("global_shortcut_registered id={SHORTCUT_REGION_SCREENSHOT} binding={binding}");
    Ok(())
  }

  #[cfg(desktop)]
  fn register_screenshot_ocr_shortcut<R: Runtime>(
    &self,
    app: &AppHandle<R>,
    next_binding: Option<&str>,
  ) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let Some(binding) = next_binding else {
      return Ok(());
    };

    let gs = app.global_shortcut();
    gs.on_shortcut(binding, |app, _shortcut, event| {
      if event.state == ShortcutState::Pressed {
        // Defer: screenshot start registers Escape and must not nest under the shortcut mutex.
        let app = app.clone();
        std::thread::spawn(move || {
          if let Err(e) = windows::screenshot::start_for_ocr(&app) {
            log::error!("screenshot_ocr_start_failed error={e}");
          }
        });
      }
    })
    .map_err(|err| format!("failed to register shortcut '{binding}': {err}"))?;

    let mut registered = self
      .registered_screenshot_ocr
      .lock()
      .map_err(|_| "shortcut runtime lock poisoned".to_string())?;
    *registered = Some(binding.to_string());
    log::info!("global_shortcut_registered id={SHORTCUT_SCREENSHOT_OCR} binding={binding}");
    Ok(())
  }
}

/// Validate a rebindable global binding string (Quick Translate / Screenshot / OCR).
pub fn validate_rebindable_binding(binding: &str) -> Result<(), String> {
  let trimmed = binding.trim();
  if trimmed.is_empty() {
    return Err("shortcut binding must not be empty".into());
  }

  #[cfg(desktop)]
  {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    let hotkey: Shortcut = trimmed
      .parse()
      .map_err(|err| format!("invalid shortcut binding '{trimmed}': {err}"))?;

    if hotkey.mods.is_empty() {
      return Err("shortcut must include at least one modifier (Ctrl, Shift, Alt, or Super)".into());
    }

    // Reserve Ctrl+C for copy / double-Ctrl+C; a single-keystroke global Ctrl+C is unsafe.
    if hotkey.matches(Modifiers::CONTROL, Code::KeyC) && hotkey.mods == Modifiers::CONTROL {
      return Err("Ctrl+C is reserved for copy and double Ctrl+C".into());
    }

    Ok(())
  }

  #[cfg(not(desktop))]
  {
    Ok(())
  }
}

/// Backward-compatible alias used by older call sites / tests.
pub fn validate_open_binding(binding: &str) -> Result<(), String> {
  validate_rebindable_binding(binding)
}

/// Validate the full shortcuts list before persistence.
pub fn validate_shortcuts(shortcuts: &[ShortcutDefinition]) -> Result<(), String> {
  let normalized = normalize_shortcuts(shortcuts.to_vec());
  let mut enabled_bindings: Vec<(String, String)> = Vec::new();

  for entry in &normalized {
    let is_rebindable = entry.id == SHORTCUT_OPEN_QUICK_TRANSLATE
      || entry.id == SHORTCUT_REGION_SCREENSHOT
      || entry.id == SHORTCUT_SCREENSHOT_OCR;
    if is_rebindable && entry.enabled {
      validate_rebindable_binding(&entry.binding)?;
      enabled_bindings.push((entry.id.clone(), entry.binding.trim().to_string()));
    }
  }

  for i in 0..enabled_bindings.len() {
    for j in (i + 1)..enabled_bindings.len() {
      if enabled_bindings[i].1.eq_ignore_ascii_case(&enabled_bindings[j].1) {
        return Err(format!(
          "Shortcuts '{}' and '{}' must use different bindings",
          enabled_bindings[i].0, enabled_bindings[j].0
        ));
      }
    }
  }

  Ok(())
}

/// Register the double Ctrl+C kmhook trigger (Windows). Gated by ShortcutRuntime.
#[cfg(windows)]
pub fn register_double_ctrl_c<R: Runtime>(app: &AppHandle<R>) {
  use kmhook::enginer as kmhook_enginer;

  let app_handle = app.clone();
  match kmhook_enginer::add_global_shortcut_trigger(
    "Ctrl+C",
    move || {
      if let Some(runtime) = app_handle.try_state::<ShortcutRuntime>() {
        if !runtime.is_double_ctrl_c_enabled() {
          return;
        }
      }
      windows::quick_translate::try_show_on_cpcp(&app_handle);
    },
    2,
    Some(400),
  ) {
    Ok(_) => {
      // startup returns Option<JoinHandle<()>>; dropping detaches the worker.
      if kmhook_enginer::startup(Some(true)).is_none() {
        log::warn!("kmhook_startup_no_worker_thread");
      }
    }
    Err(err) => {
      log::error!("kmhook_double_ctrl_c_register_failed error={err}");
    }
  }
}
