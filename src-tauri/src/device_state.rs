// ABOUTME: Atomic versioned JSON reads/writes for machine-specific device state.
// ABOUTME: Window geometry lives here; never exported and safe to delete.
use crate::consts::DEVICE_STATE_FILENAME;
use crate::domain::time::now_filename_utc;
use crate::error::StorageError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::NamedTempFile;

pub const DEVICE_STATE_FORMAT_VERSION: u32 = 1;
const DEFAULT_DEBOUNCE_MS: u64 = 300;
const MAX_GEOMETRY_DIMENSION: f64 = 100_000.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  pub maximized: bool,
}

impl WindowGeometry {
  pub fn default_main() -> Self {
    Self {
      x: 0.0,
      y: 0.0,
      width: 800.0,
      height: 600.0,
      maximized: false,
    }
  }

  pub fn is_valid_size(&self) -> bool {
    self.width.is_finite()
      && self.height.is_finite()
      && self.x.is_finite()
      && self.y.is_finite()
      && self.width > 0.0
      && self.height > 0.0
      && self.width <= MAX_GEOMETRY_DIMENSION
      && self.height <= MAX_GEOMETRY_DIMENSION
      && self.x.abs() <= MAX_GEOMETRY_DIMENSION
      && self.y.abs() <= MAX_GEOMETRY_DIMENSION
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStateV1 {
  pub format_version: u32,
  pub main_window: WindowGeometry,
}

impl DeviceStateV1 {
  pub fn default_state() -> Self {
    Self {
      format_version: DEVICE_STATE_FORMAT_VERSION,
      main_window: WindowGeometry::default_main(),
    }
  }
}

/// Manages device-state.json with atomic writes and real delayed debouncing.
pub struct DeviceStateManager {
  path: PathBuf,
  state: Mutex<DeviceStateV1>,
  pending: Mutex<Option<DeviceStateV1>>,
  /// Monotonic generation for the latest scheduled write.
  generation: AtomicU64,
  debounce: Duration,
  /// Serializes delayed and final flushes.
  write_lock: Mutex<()>,
}

impl DeviceStateManager {
  pub fn load(app_data_dir: impl AsRef<Path>) -> Result<Self, StorageError> {
    Self::load_with_debounce(app_data_dir, Duration::from_millis(DEFAULT_DEBOUNCE_MS))
  }

  pub fn load_with_debounce(app_data_dir: impl AsRef<Path>, debounce: Duration) -> Result<Self, StorageError> {
    let app_data_dir = app_data_dir.as_ref();
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(DEVICE_STATE_FILENAME);
    let state = load_state(&path)?;
    Ok(Self {
      path,
      state: Mutex::new(state),
      pending: Mutex::new(None),
      generation: AtomicU64::new(0),
      debounce,
      write_lock: Mutex::new(()),
    })
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  pub fn current(&self) -> DeviceStateV1 {
    self.state.lock().expect("device state lock").clone()
  }

  pub fn main_window(&self) -> WindowGeometry {
    self.current().main_window
  }

  /// Queue a debounced write of main window geometry.
  ///
  /// While maximized, only the maximized flag is set; the last normal rectangle is retained.
  pub fn schedule_main_window(self: &Arc<Self>, geometry: WindowGeometry) {
    if !geometry.is_valid_size() {
      return;
    }
    let mut next = self.current();
    if geometry.maximized {
      next.main_window.maximized = true;
    } else {
      next.main_window = geometry;
    }
    *self.pending.lock().expect("pending lock") = Some(next);
    let generation_id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let delay = self.debounce;
    let mgr = Arc::clone(self);
    std::thread::spawn(move || {
      std::thread::sleep(delay);
      if mgr.generation.load(Ordering::SeqCst) != generation_id {
        return;
      }
      let _ = mgr.flush_if_generation(generation_id);
    });
  }

  /// Persist pending state if the generation is still current.
  fn flush_if_generation(&self, generation_id: u64) -> Result<(), StorageError> {
    if self.generation.load(Ordering::SeqCst) != generation_id {
      return Ok(());
    }
    self.flush()
  }

  /// Persist pending state immediately (e.g. before exit).
  ///
  /// On failure, pending state is retained for retry and the previous durable file is preserved.
  pub fn flush(&self) -> Result<(), StorageError> {
    let _guard = self.write_lock.lock().expect("write lock");
    let pending = self.pending.lock().expect("pending lock").clone();
    let Some(state) = pending else {
      return Ok(());
    };
    match write_state_atomic(&self.path, &state) {
      Ok(()) => {
        *self.state.lock().expect("device state lock") = state;
        *self.pending.lock().expect("pending lock") = None;
        Ok(())
      }
      Err(e) => {
        // Retain pending for retry; do not clear.
        Err(e)
      }
    }
  }

  /// Apply and persist immediately without debounce.
  pub fn set_and_flush(&self, state: DeviceStateV1) -> Result<(), StorageError> {
    let _guard = self.write_lock.lock().expect("write lock");
    write_state_atomic(&self.path, &state)?;
    *self.state.lock().expect("device state lock") = state;
    *self.pending.lock().expect("pending lock") = None;
    Ok(())
  }

  #[cfg(test)]
  pub fn has_pending(&self) -> bool {
    self.pending.lock().expect("pending lock").is_some()
  }
}

fn load_state(path: &Path) -> Result<DeviceStateV1, StorageError> {
  if !path.exists() {
    return Ok(DeviceStateV1::default_state());
  }
  let raw = fs::read_to_string(path)?;
  match serde_json::from_str::<DeviceStateV1>(&raw) {
    Ok(state) if state.format_version == DEVICE_STATE_FORMAT_VERSION => {
      if !state.main_window.is_valid_size() {
        return Ok(DeviceStateV1::default_state());
      }
      Ok(state)
    }
    _ => {
      quarantine_invalid(path)?;
      Ok(DeviceStateV1::default_state())
    }
  }
}

fn quarantine_invalid(path: &Path) -> Result<(), StorageError> {
  let stamp = now_filename_utc();
  let dest = path.with_file_name(format!("device-state.invalid-{stamp}.json"));
  let _ = fs::rename(path, dest);
  Ok(())
}

fn write_state_atomic(path: &Path, state: &DeviceStateV1) -> Result<(), StorageError> {
  let parent = path.parent().unwrap_or_else(|| Path::new("."));
  fs::create_dir_all(parent)?;
  let json = serde_json::to_string_pretty(state)?;
  let mut temp = NamedTempFile::new_in(parent)?;
  use std::io::Write;
  temp.write_all(json.as_bytes())?;
  temp.flush()?;
  temp.as_file().sync_all()?;
  temp.persist(path).map_err(|e| StorageError::Io(e.error))?;
  Ok(())
}

/// Shared handle for tray flush and window events.
pub type SharedDeviceState = Arc<DeviceStateManager>;

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;

  #[test]
  fn missing_file_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = DeviceStateManager::load(dir.path()).unwrap();
    assert_eq!(mgr.current().format_version, 1);
    assert_eq!(mgr.main_window().width, 800.0);
  }

  #[test]
  fn round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = DeviceStateManager::load(dir.path()).unwrap();
    let mut state = mgr.current();
    state.main_window = WindowGeometry {
      x: 10.0,
      y: 20.0,
      width: 1000.0,
      height: 700.0,
      maximized: true,
    };
    mgr.set_and_flush(state.clone()).unwrap();
    let mgr2 = DeviceStateManager::load(dir.path()).unwrap();
    assert_eq!(mgr2.current(), state);
  }

  #[test]
  fn invalid_schema_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DEVICE_STATE_FILENAME);
    fs::write(&path, r#"{"formatVersion":99,"mainWindow":{}}"#).unwrap();
    let mgr = DeviceStateManager::load(dir.path()).unwrap();
    assert_eq!(mgr.current().format_version, 1);
    let quarantined: Vec<_> = fs::read_dir(dir.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().contains("device-state.invalid-"))
      .collect();
    assert_eq!(quarantined.len(), 1);
  }

  #[test]
  fn corrupt_json_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DEVICE_STATE_FILENAME);
    fs::write(&path, "not-json").unwrap();
    let mgr = DeviceStateManager::load(dir.path()).unwrap();
    assert_eq!(mgr.main_window().width, 800.0);
  }

  #[test]
  fn invalid_geometry_falls_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DEVICE_STATE_FILENAME);
    fs::write(
      &path,
      r#"{"formatVersion":1,"mainWindow":{"x":0,"y":0,"width":0,"height":0,"maximized":false}}"#,
    )
    .unwrap();
    let mgr = DeviceStateManager::load(dir.path()).unwrap();
    assert_eq!(mgr.main_window().width, 800.0);
  }

  #[test]
  fn non_finite_geometry_rejected() {
    let geo = WindowGeometry {
      x: f64::NAN,
      y: 0.0,
      width: 800.0,
      height: 600.0,
      maximized: false,
    };
    assert!(!geo.is_valid_size());
  }

  #[test]
  fn huge_geometry_rejected() {
    let geo = WindowGeometry {
      x: 0.0,
      y: 0.0,
      width: 1_000_000.0,
      height: 600.0,
      maximized: false,
    };
    assert!(!geo.is_valid_size());
  }

  #[test]
  fn debounce_latest_wins() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = Arc::new(DeviceStateManager::load_with_debounce(dir.path(), Duration::from_millis(50)).unwrap());
    mgr.schedule_main_window(WindowGeometry {
      x: 1.0,
      y: 1.0,
      width: 900.0,
      height: 600.0,
      maximized: false,
    });
    mgr.schedule_main_window(WindowGeometry {
      x: 2.0,
      y: 2.0,
      width: 1000.0,
      height: 700.0,
      maximized: false,
    });
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(mgr.main_window().width, 1000.0);
    assert_eq!(mgr.main_window().x, 2.0);
    assert!(!mgr.has_pending());
  }

  #[test]
  fn maximized_preserves_normal_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = Arc::new(DeviceStateManager::load(dir.path()).unwrap());
    mgr.schedule_main_window(WindowGeometry {
      x: 40.0,
      y: 50.0,
      width: 900.0,
      height: 650.0,
      maximized: false,
    });
    // Force immediate flush of normal geometry.
    mgr.flush().unwrap();
    mgr.schedule_main_window(WindowGeometry {
      x: 0.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
      maximized: true,
    });
    mgr.flush().unwrap();
    let geo = mgr.main_window();
    assert!(geo.maximized);
    assert_eq!(geo.width, 900.0);
    assert_eq!(geo.x, 40.0);
  }
}
