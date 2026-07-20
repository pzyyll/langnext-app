// ABOUTME: Runtime registration for global open-Quick-Translate and double Ctrl+C.
// ABOUTME: Applies settings bindings, gates kmhook, and validates rebindable shortcuts.
use crate::consts::{DEFAULT_OPEN_QUICK_TRANSLATE_BINDING, SHORTCUT_DOUBLE_CTRL_C, SHORTCUT_OPEN_QUICK_TRANSLATE};
use crate::domain::settings::{normalize_shortcuts, ShortcutDefinition};
use crate::windows;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// App-managed shortcut runtime flags and last-registered open binding.
#[derive(Debug, Default)]
pub struct ShortcutRuntime {
  /// Currently registered open-Quick-Translate binding, if any.
  registered_open: Mutex<Option<String>>,
  /// When false, the double Ctrl+C kmhook callback is a no-op.
  double_ctrl_c_enabled: AtomicBool,
}

impl ShortcutRuntime {
  pub fn new() -> Self {
    Self {
      registered_open: Mutex::new(None),
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
  /// partial apply is avoided by validating the open binding first.
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
    let double_enabled = normalized
      .iter()
      .find(|s| s.id == SHORTCUT_DOUBLE_CTRL_C)
      .map(|s| s.enabled)
      .unwrap_or(true);

    if open.enabled {
      validate_open_binding(&open.binding)?;
    }

    self.double_ctrl_c_enabled.store(double_enabled, Ordering::SeqCst);

    #[cfg(desktop)]
    {
      self.apply_open_shortcut(app, open.enabled.then_some(open.binding.as_str()))?;
    }

    #[cfg(not(desktop))]
    {
      let _ = app;
      let _ = open;
    }

    Ok(())
  }

  #[cfg(desktop)]
  fn apply_open_shortcut<R: Runtime>(&self, app: &AppHandle<R>, next_binding: Option<&str>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    let mut registered = self
      .registered_open
      .lock()
      .map_err(|_| "shortcut runtime lock poisoned".to_string())?;

    if registered.as_deref() == next_binding {
      return Ok(());
    }

    let previous = registered.take();
    if let Some(ref prev) = previous {
      if let Err(err) = gs.unregister(prev.as_str()) {
        log::warn!("global_shortcut_unregister_failed binding={prev} error={err}");
      }
    }

    let Some(binding) = next_binding else {
      return Ok(());
    };

    if let Err(err) = gs.on_shortcut(binding, |app, _shortcut, event| {
      if event.state == ShortcutState::Pressed {
        if let Err(e) = windows::quick_translate::show(app) {
          log::error!("quick_translate_show_failed error={e}");
        }
      }
    }) {
      // Best-effort restore so a failed rebind does not leave the app without a shortcut.
      if let Some(prev) = previous {
        if gs
          .on_shortcut(prev.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
              if let Err(e) = windows::quick_translate::show(app) {
                log::error!("quick_translate_show_failed error={e}");
              }
            }
          })
          .is_ok()
        {
          *registered = Some(prev);
        }
      }
      return Err(format!("failed to register shortcut '{binding}': {err}"));
    }

    *registered = Some(binding.to_string());
    log::info!("global_shortcut_registered binding={binding}");
    Ok(())
  }
}

/// Validate a rebindable open-Quick-Translate binding string.
pub fn validate_open_binding(binding: &str) -> Result<(), String> {
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

/// Validate the full shortcuts list before persistence.
pub fn validate_shortcuts(shortcuts: &[ShortcutDefinition]) -> Result<(), String> {
  let normalized = normalize_shortcuts(shortcuts.to_vec());
  for entry in &normalized {
    if entry.id == SHORTCUT_OPEN_QUICK_TRANSLATE && entry.enabled {
      validate_open_binding(&entry.binding)?;
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
